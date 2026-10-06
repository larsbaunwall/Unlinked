import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_TTL_MS = 6 * HOUR;
export const EMPTY_TTL_MS = 10 * MINUTE;
/** Temp files from interrupted writes older than this are swept. */
const STALE_TMP_MS = HOUR;

const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: 24 * HOUR };

/** Parses `UNLINKED_CACHE_TTL` values such as `30m`, `2h`, `1d`, `90s` or `0` (off). */
export function parseCacheTtl(value: string | undefined): { ttlMs: number; valid: boolean } {
  const text = value?.trim().toLowerCase() ?? "";
  if (text === "") {
    return { ttlMs: DEFAULT_TTL_MS, valid: true };
  }
  if (text === "0") {
    return { ttlMs: 0, valid: true };
  }
  const match = text.match(/^(\d+)([smhd])$/);
  if (!match) {
    return { ttlMs: DEFAULT_TTL_MS, valid: false };
  }
  return { ttlMs: Number(match[1]) * UNIT_MS[match[2]!]!, valid: true };
}

/**
 * The OS cache directory (the caller appends `unlinked/`), or undefined when there is no safe absolute location.
 * Relative or blank environment values and a missing home are ignored, so the cache never lands under the cwd.
 */
export function defaultCacheDir({
  platform = process.platform,
  env = process.env,
  home = homedir(),
}: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string | undefined {
  const path = platform === "win32" ? win32 : posix;
  const absolute = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && path.isAbsolute(trimmed) ? trimmed : undefined;
  };
  const fromEnv = absolute(platform === "win32" ? env.LOCALAPPDATA : platform === "darwin" ? undefined : env.XDG_CACHE_HOME);
  if (fromEnv) {
    return fromEnv;
  }
  const base = absolute(home);
  if (!base) {
    return undefined;
  }
  if (platform === "darwin") {
    return path.join(base, "Library", "Caches");
  }
  return platform === "win32" ? path.join(base, "AppData", "Local") : path.join(base, ".cache");
}

/**
 * True when `dir` is absent or a real directory owned by this user. A symlink (it could point anywhere) or a
 * directory owned by someone else is not trusted: reading would load planted data and writing would leak ours.
 */
async function isSafeDir(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return false;
    }
    return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export type CacheOptions = {
  /** Used only to namespace the disk cache (sha256 prefix); never stored. */
  token: string;
  /** Base cache directory. Omit for a memory-only cache (the MCP server). */
  cacheDir?: string;
  /** Time to live in ms. 0 disables caching. Defaults to 6 hours. */
  ttlMs?: number;
  /** Time to live for empty results in ms. Defaults to 10 minutes (never longer than `ttlMs`). */
  emptyTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type GetOptions<T> = {
  /** Bypass the cache and rewrite it. */
  refresh?: boolean;
  /** Marks a result as empty so it expires sooner. */
  isEmpty?: (value: T) => boolean;
  /** Checks data read from disk (another version, a hand edit or corruption can leave any JSON there). */
  validate?: (value: unknown) => value is T;
};

export type Cached<T> = { value: T; fetchedAt: number };

type Entry = {
  promise: Promise<Cached<unknown>>;
  fetchedAt: number;
  ttlMs: number;
};

/**
 * Two-layer cache: an in-memory map of in-flight/settled promises (single-flight) plus an optional,
 * best-effort disk layer shared between CLI processes. Errors are never cached.
 */
export class Cache {
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #emptyTtlMs: number;
  readonly #now: () => number;
  readonly #tokenDir: string | undefined;
  readonly #baseDir: string | undefined;
  #swept: Promise<void> | undefined;

  constructor({ token, cacheDir, ttlMs = DEFAULT_TTL_MS, emptyTtlMs = EMPTY_TTL_MS, now = Date.now }: CacheOptions) {
    this.#ttlMs = ttlMs;
    this.#emptyTtlMs = Math.min(emptyTtlMs, ttlMs);
    this.#now = now;
    if (cacheDir !== undefined) {
      this.#baseDir = join(cacheDir, "unlinked");
      this.#tokenDir = join(this.#baseDir, createHash("sha256").update(token).digest("hex").slice(0, 16));
    }
  }

  /** False when the TTL is 0: every call refetches, so results from different calls are not comparable. */
  get enabled(): boolean {
    return this.#ttlMs > 0;
  }

  async get<T>(key: string, load: () => Promise<T>, options: GetOptions<T> = {}): Promise<Cached<T>> {
    if (this.#ttlMs === 0) {
      const value = await load();
      return { value, fetchedAt: this.#now() };
    }

    if (!options.refresh) {
      const existing = this.#entries.get(key);
      if (existing && this.#isFresh(existing)) {
        return existing.promise as Promise<Cached<T>>;
      }
    }

    // A refresh that fails must not cost the last good value, so remember what it replaces.
    const previous = options.refresh ? this.#entries.get(key) : undefined;
    const entry: Entry = { promise: undefined as never, fetchedAt: this.#now(), ttlMs: this.#ttlMs };
    entry.promise = this.#fill(key, entry, load, options);
    this.#entries.set(key, entry);
    // On failure put the previous entry back (or drop this one), but only if a newer one has not replaced it.
    entry.promise.catch(() => {
      if (this.#entries.get(key) === entry) {
        if (previous) {
          this.#entries.set(key, previous);
        } else {
          this.#entries.delete(key);
        }
      }
    });
    return entry.promise as Promise<Cached<T>>;
  }

  /** Clears the in-memory entries and this token's disk files. */
  async clear(): Promise<void> {
    this.#entries.clear();
    if (this.#tokenDir) {
      await rm(this.#tokenDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #isFresh(entry: Entry): boolean {
    return this.#now() - entry.fetchedAt < entry.ttlMs;
  }

  async #fill<T>(key: string, entry: Entry, load: () => Promise<T>, options: GetOptions<T>): Promise<Cached<T>> {
    const finish = (value: T, fetchedAt: number): Cached<T> => {
      entry.fetchedAt = fetchedAt;
      entry.ttlMs = options.isEmpty?.(value) ? this.#emptyTtlMs : this.#ttlMs;
      return { value, fetchedAt };
    };

    if (!options.refresh) {
      const fromDisk = await this.#readDisk<T>(key);
      const trusted =
        fromDisk !== undefined &&
        // A timestamp in the future (clock change, hand edit) would keep the entry "fresh" far too long.
        fromDisk.fetchedAt <= this.#now() &&
        (options.validate === undefined || options.validate(fromDisk.data));
      if (fromDisk && trusted) {
        const ttl = options.isEmpty?.(fromDisk.data) ? this.#emptyTtlMs : this.#ttlMs;
        if (this.#now() - fromDisk.fetchedAt < ttl) {
          return finish(fromDisk.data, fromDisk.fetchedAt);
        }
      }
    }

    const value = await load();
    const result = finish(value, this.#now());
    // A load that finished after a refresh replaced this entry is stale: do not clobber the newer file.
    if (this.#entries.get(key) === entry) {
      await this.#writeDisk(key, result);
    }
    return result;
  }

  #file(key: string): string | undefined {
    return this.#tokenDir ? join(this.#tokenDir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`) : undefined;
  }

  /** False when the disk layer is off or one of its directories is a symlink or not ours: then only memory is used. */
  async #diskUsable(): Promise<boolean> {
    return this.#baseDir !== undefined && this.#tokenDir !== undefined && (await isSafeDir(this.#baseDir)) && (await isSafeDir(this.#tokenDir));
  }

  /** Once per instance, best-effort: removes `.tmp` files that a killed write left behind. */
  #sweepOnce(): Promise<void> {
    this.#swept ??= this.#sweep();
    return this.#swept;
  }

  async #sweep(): Promise<void> {
    if (!this.#tokenDir || !(await this.#diskUsable())) {
      return;
    }
    try {
      const cutoff = this.#now() - STALE_TMP_MS;
      for (const name of await readdir(this.#tokenDir)) {
        if (!name.endsWith(".tmp")) {
          continue;
        }
        const file = join(this.#tokenDir, name);
        const info = await stat(file).catch(() => undefined);
        if (info?.isFile() && info.mtimeMs < cutoff) {
          await rm(file, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // Missing directory, permissions, concurrent clear: nothing to sweep.
    }
  }

  async #readDisk<T>(key: string): Promise<{ fetchedAt: number; data: T } | undefined> {
    const file = this.#file(key);
    if (!file) {
      return undefined;
    }
    await this.#sweepOnce();
    if (!(await this.#diskUsable())) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { fetchedAt?: unknown }).fetchedAt === "number" &&
        "data" in parsed
      ) {
        return parsed as { fetchedAt: number; data: T };
      }
    } catch {
      // Missing or corrupt: treat as a miss.
    }
    return undefined;
  }

  async #writeDisk<T>(key: string, { value, fetchedAt }: Cached<T>): Promise<void> {
    const file = this.#file(key);
    if (!file || !this.#tokenDir || !this.#baseDir) {
      return;
    }
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(this.#tokenDir, { recursive: true, mode: 0o700 });
      // Checked after mkdir (which follows links) and before chmod/write (which would too).
      if (!(await this.#diskUsable())) {
        return;
      }
      await chmod(this.#baseDir, 0o700).catch(() => undefined);
      await chmod(this.#tokenDir, 0o700).catch(() => undefined);
      await writeFile(temp, JSON.stringify({ fetchedAt, data: value }), { mode: 0o600, flag: "wx" });
      // Atomic on POSIX: readers see the old or the new file, never a partial one.
      await rename(temp, file);
    } catch {
      // Best-effort cache: ignore write errors (read-only dir, EPERM on Windows, concurrent clear, ...).
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

/** Removes every cached file for every token. */
export async function clearAllDiskCache(cacheDir: string): Promise<void> {
  try {
    await rm(join(cacheDir, "unlinked"), { recursive: true, force: true });
  } catch (error) {
    // A cache directory that is really a file has nothing to clear.
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") {
      throw error;
    }
  }
}
