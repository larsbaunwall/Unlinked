import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cache, clearAllDiskCache, defaultCacheDir, parseCacheTtl } from "../src/cache.js";
import { tempDir } from "./helpers/temp-dir.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const TOKEN = "synthetic-secret-token-value";
// First 16 hex characters of sha256(TOKEN), a literal so the test does not mirror the implementation.
const TOKEN_NAMESPACE = "f32f38539b47ca71";

function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function counter<T>(value: T) {
  const state = { calls: 0 };
  return { state, load: async () => (state.calls++, value) };
}

describe("parseCacheTtl", () => {
  const cases: Array<[string | undefined, number, boolean]> = [
    [undefined, 6 * HOUR, true],
    ["", 6 * HOUR, true],
    ["30m", 30 * MIN, true],
    ["2h", 2 * HOUR, true],
    ["90s", 90_000, true],
    ["1d", 24 * HOUR, true],
    ["0", 0, true],
    [" 2H ", 2 * HOUR, true],
    ["banana", 6 * HOUR, false],
    ["-5m", 6 * HOUR, false],
    ["10", 6 * HOUR, false],
    ["30mx", 6 * HOUR, false],
    ["x30m", 6 * HOUR, false],
    ["30 m", 6 * HOUR, false],
    ["1w", 6 * HOUR, false],
  ];
  for (const [input, ttlMs, valid] of cases) {
    test(`${JSON.stringify(input)}`, () => assert.deepEqual(parseCacheTtl(input), { ttlMs, valid }));
  }
});

describe("memory layer", () => {
  test("two concurrent gets share one load (single-flight)", async () => {
    const cache = new Cache({ token: TOKEN });
    const gate = deferred<string>();
    let calls = 0;
    const load = () => (calls++, gate.promise);
    const a = cache.get("k", load);
    const b = cache.get("k", load);
    gate.resolve("v");
    assert.equal((await a).value, "v");
    assert.equal((await b).value, "v");
    assert.equal(calls, 1);
  });

  test("serves from cache until the TTL expires, then refetches", async () => {
    const c = clock();
    const cache = new Cache({ token: TOKEN, now: c.now });
    const { state, load } = counter("v");
    await cache.get("k", load);
    c.advance(6 * HOUR - 1);
    await cache.get("k", load);
    assert.equal(state.calls, 1);
    c.advance(1);
    await cache.get("k", load);
    assert.equal(state.calls, 2);
  });

  test("reports when the value was fetched", async () => {
    const c = clock();
    const cache = new Cache({ token: TOKEN, now: c.now });
    const first = await cache.get("k", async () => "v");
    c.advance(MIN);
    const second = await cache.get("k", async () => "other");
    assert.equal(first.fetchedAt, 1_000_000_000_000);
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(second.value, "v");
  });

  test("refresh bypasses the cache and replaces the entry", async () => {
    const cache = new Cache({ token: TOKEN });
    await cache.get("k", async () => "old");
    assert.equal((await cache.get("k", async () => "new", { refresh: true })).value, "new");
    assert.equal((await cache.get("k", async () => "never")).value, "new");
  });

  test("ttl 0 disables caching", async () => {
    const cache = new Cache({ token: TOKEN, ttlMs: 0 });
    const { state, load } = counter("v");
    await cache.get("k", load);
    await cache.get("k", load);
    assert.equal(state.calls, 2);
  });

  test("keys are independent", async () => {
    const cache = new Cache({ token: TOKEN });
    assert.equal((await cache.get("a", async () => 1)).value, 1);
    assert.equal((await cache.get("b", async () => 2)).value, 2);
  });

  test("empty results use the shorter 10 minute TTL", async () => {
    const c = clock();
    const cache = new Cache({ token: TOKEN, now: c.now });
    const { state, load } = counter<string[]>([]);
    const opts = { isEmpty: (v: string[]) => v.length === 0 };
    await cache.get("k", load, opts);
    c.advance(10 * MIN - 1);
    await cache.get("k", load, opts);
    assert.equal(state.calls, 1);
    c.advance(1);
    await cache.get("k", load, opts);
    assert.equal(state.calls, 2);
  });

  test("empty TTL never exceeds a shorter configured TTL", async () => {
    const c = clock();
    const cache = new Cache({ token: TOKEN, now: c.now, ttlMs: 5 * MIN });
    const { state, load } = counter<string[]>([]);
    const opts = { isEmpty: (v: string[]) => v.length === 0 };
    await cache.get("k", load, opts);
    c.advance(5 * MIN);
    await cache.get("k", load, opts);
    assert.equal(state.calls, 2);
  });

  test("errors are never cached", async () => {
    const cache = new Cache({ token: TOKEN });
    await assert.rejects(cache.get("k", async () => Promise.reject(new Error("boom"))), /boom/);
    assert.equal((await cache.get("k", async () => "ok")).value, "ok");
  });

  test("a failed in-flight request does not evict a newer refresh entry", async () => {
    const cache = new Cache({ token: TOKEN });
    const first = deferred<string>();
    const pending = cache.get("k", () => first.promise);
    const refreshed = await cache.get("k", async () => "fresh", { refresh: true });
    assert.equal(refreshed.value, "fresh");
    first.reject(new Error("late failure"));
    await assert.rejects(pending, /late failure/);
    const { state, load } = counter("never");
    assert.equal((await cache.get("k", load)).value, "fresh");
    assert.equal(state.calls, 0);
  });

  test("a failed request is cleared so the next call retries", async () => {
    const cache = new Cache({ token: TOKEN });
    const gate = deferred<string>();
    const pending = cache.get("k", () => gate.promise);
    gate.reject(new Error("x"));
    await assert.rejects(pending);
    const { state, load } = counter("v");
    await cache.get("k", load);
    assert.equal(state.calls, 1);
  });

  test("a refresh that fails keeps the last good value: the next plain get is served from it, with no new load", async () => {
    const cache = new Cache({ token: TOKEN });
    await cache.get("k", async () => "good");
    await assert.rejects(cache.get("k", async () => Promise.reject(new Error("refresh failed")), { refresh: true }), /refresh failed/);
    const { state, load } = counter("never");
    const after = await cache.get("k", load);
    assert.equal(after.value, "good");
    assert.equal(state.calls, 0);
  });

  test("a failed refresh keeps the original fetchedAt, so the old value still expires on schedule", async () => {
    const c = clock();
    const cache = new Cache({ token: TOKEN, now: c.now });
    await cache.get("k", async () => "good");
    c.advance(HOUR);
    await assert.rejects(cache.get("k", async () => Promise.reject(new Error("x")), { refresh: true }));
    assert.equal((await cache.get("k", async () => "never")).fetchedAt, 1_000_000_000_000);
    c.advance(5 * HOUR);
    assert.equal((await cache.get("k", async () => "reloaded")).value, "reloaded");
  });

  test("a refresh that fails with nothing cached before leaves nothing behind", async () => {
    const cache = new Cache({ token: TOKEN });
    await assert.rejects(cache.get("k", async () => Promise.reject(new Error("x")), { refresh: true }));
    const { state, load } = counter("fresh");
    assert.equal((await cache.get("k", load)).value, "fresh");
    assert.equal(state.calls, 1);
  });

  test("a failed refresh does not undo a newer successful refresh (the entry is restored only if it is still the same one)", async () => {
    const cache = new Cache({ token: TOKEN });
    await cache.get("k", async () => "v1");
    const slow = deferred<string>();
    const failing = cache.get("k", () => slow.promise, { refresh: true });
    await cache.get("k", async () => "v3", { refresh: true });
    slow.reject(new Error("late failure"));
    await assert.rejects(failing, /late failure/);
    const { state, load } = counter("never");
    assert.equal((await cache.get("k", load)).value, "v3");
    assert.equal(state.calls, 0);
  });

  test("clear drops memory entries", async () => {
    const cache = new Cache({ token: TOKEN });
    await cache.get("k", async () => "v");
    await cache.clear();
    const { state, load } = counter("v2");
    assert.equal((await cache.get("k", load)).value, "v2");
    assert.equal(state.calls, 1);
  });
});

describe("disk layer", () => {
  // sha256("synthetic-secret-token-value") truncated to 16 hex characters, hard-coded on purpose.
  const hash = TOKEN_NAMESPACE;

  test("a second instance (another process) reads what the first wrote", async () => {
    const dir = await tempDir();
    const c = clock();
    await new Cache({ token: TOKEN, cacheDir: dir, now: c.now }).get("snapshot:POSITIONS", async () => [{ a: 1 }]);
    const { state, load } = counter<unknown>("never");
    const second = await new Cache({ token: TOKEN, cacheDir: dir, now: c.now }).get("snapshot:POSITIONS", load);
    assert.deepEqual(second.value, [{ a: 1 }]);
    assert.equal(second.fetchedAt, 1_000_000_000_000);
    assert.equal(state.calls, 0);
  });

  test("stores under <dir>/unlinked/<sha256(token)[0:16]>/ with owner-only permissions", async () => {
    const dir = await tempDir();
    await new Cache({ token: TOKEN, cacheDir: dir, now: () => 1_000_000_000_000 }).get("snapshot:POSITIONS", async () => ({ ok: true }));
    const tokenDir = join(dir, "unlinked", hash);
    const files = await readdir(tokenDir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /\.json$/);
    assert.equal((await stat(tokenDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "unlinked"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(tokenDir, files[0]!))).mode & 0o777, 0o600);
    const content = JSON.parse(await readFile(join(tokenDir, files[0]!), "utf8"));
    assert.deepEqual(content, { fetchedAt: 1_000_000_000_000, data: { ok: true } });
  });

  test("the token never appears in any path or file", async () => {
    const dir = await tempDir();
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => ({ ok: true }));
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const name of await readdir(d, { withFileTypes: true })) {
        const p = join(d, name.name);
        out.push(p, ...(name.isDirectory() ? await walk(p) : [await readFile(p, "utf8")]));
      }
      return out;
    };
    for (const text of await walk(dir)) {
      assert.ok(!text.includes(TOKEN));
    }
  });

  test("a different token misses", async () => {
    const dir = await tempDir();
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "mine");
    const other = await new Cache({ token: "another-token", cacheDir: dir }).get("k", async () => "theirs");
    assert.equal(other.value, "theirs");
  });

  test("expired disk entries are refetched", async () => {
    const dir = await tempDir();
    const c = clock();
    await new Cache({ token: TOKEN, cacheDir: dir, now: c.now }).get("k", async () => "old");
    c.advance(6 * HOUR);
    const result = await new Cache({ token: TOKEN, cacheDir: dir, now: c.now }).get("k", async () => "new");
    assert.equal(result.value, "new");
  });

  test("empty disk entries expire after 10 minutes", async () => {
    const dir = await tempDir();
    const c = clock();
    const opts = { isEmpty: (v: unknown[]) => v.length === 0 };
    await new Cache({ token: TOKEN, cacheDir: dir, now: c.now }).get("k", async () => [] as unknown[], opts);
    c.advance(10 * MIN);
    const result = await new Cache({ token: TOKEN, cacheDir: dir, now: c.now }).get("k", async () => [1], opts);
    assert.deepEqual(result.value, [1]);
  });

  test("a stale load finishing after a refresh does not overwrite the newer disk entry", async () => {
    const dir = await tempDir();
    const cache = new Cache({ token: TOKEN, cacheDir: dir });
    const slow = deferred<string>();
    const stale = cache.get("k", () => slow.promise);
    await new Promise((resolve) => setImmediate(resolve));
    await cache.get("k", async () => "fresh", { refresh: true });
    slow.resolve("stale");
    await stale;
    const { state, load } = counter("never");
    const reader = await new Cache({ token: TOKEN, cacheDir: dir }).get("k", load);
    assert.equal(reader.value, "fresh");
    assert.equal(state.calls, 0);
  });

  test("refresh skips the disk read and rewrites the file", async () => {
    const dir = await tempDir();
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "old");
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "new", { refresh: true });
    assert.equal((await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "never")).value, "new");
  });

  test("a refresh that fails keeps the last good value on disk: a new process still reads it, with no load", async () => {
    const dir = await tempDir();
    const cache = new Cache({ token: TOKEN, cacheDir: dir });
    await cache.get("k", async () => "good");
    await assert.rejects(cache.get("k", async () => Promise.reject(new Error("refresh failed")), { refresh: true }), /refresh failed/);
    const same = counter("never");
    assert.equal((await cache.get("k", same.load)).value, "good");
    assert.equal(same.state.calls, 0);
    const other = counter("never");
    assert.equal((await new Cache({ token: TOKEN, cacheDir: dir }).get("k", other.load)).value, "good");
    assert.equal(other.state.calls, 0);
  });

  test("a corrupt or malformed file is a miss", async () => {
    const dir = await tempDir();
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "old");
    const tokenDir = join(dir, "unlinked", hash);
    const [file] = await readdir(tokenDir);
    for (const junk of ["{not json", "[]", '{"fetchedAt":"x","data":1}', ""]) {
      await writeFile(join(tokenDir, file!), junk);
      const result = await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "fresh");
      assert.equal(result.value, "fresh", junk);
    }
  });

  test("leaves no temp files behind", async () => {
    const dir = await tempDir();
    const cache = new Cache({ token: TOKEN, cacheDir: dir });
    await Promise.all([cache.get("a", async () => 1), cache.get("b", async () => 2), cache.get("a", async () => 3, { refresh: true })]);
    const files = await readdir(join(dir, "unlinked", hash));
    assert.ok(files.every((f) => f.endsWith(".json")), files.join(","));
  });

  test("keys with unsafe characters cannot escape the cache directory", async () => {
    const dir = await tempDir();
    const outer = await tempDir();
    const nested = join(outer, "a", "b", "cache");
    await mkdir(nested, { recursive: true });
    await new Cache({ token: TOKEN, cacheDir: nested }).get("../../evil/key", async () => 1);
    assert.deepEqual(await readdir(join(nested, "unlinked", hash)), [".._.._evil_key.json"]);
    // Nothing was created next to the token directory, above it, or in the cache base.
    assert.deepEqual(await readdir(join(nested, "unlinked")), [hash]);
    assert.deepEqual(await readdir(nested), ["unlinked"]);
    assert.deepEqual(await readdir(join(outer, "a", "b")), ["cache"]);
    assert.deepEqual(await readdir(join(outer, "a")), ["b"]);
    assert.deepEqual(await readdir(outer), ["a"]);
    await assert.rejects(stat(join(nested, "unlinked", "evil")));
    assert.deepEqual(await readdir(dir), []);
  });

  test("clear removes this token's files; clearAllDiskCache removes everything", async () => {
    const dir = await tempDir();
    const mine = new Cache({ token: TOKEN, cacheDir: dir });
    await mine.get("k", async () => "v");
    await new Cache({ token: "other", cacheDir: dir }).get("k", async () => "w");
    await mine.clear();
    assert.deepEqual(await readdir(join(dir, "unlinked")).then((l) => l.length), 1);
    await clearAllDiskCache(dir);
    await assert.rejects(stat(join(dir, "unlinked")));
    await clearAllDiskCache(dir); // idempotent
  });

  test("pre-existing <dir>/unlinked with loose permissions is tightened to 0700", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "unlinked"), { mode: 0o755 });
    await chmod(join(dir, "unlinked"), 0o755);
    assert.equal((await stat(join(dir, "unlinked"))).mode & 0o777, 0o755);
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "v");
    assert.equal((await stat(join(dir, "unlinked"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "unlinked", hash))).mode & 0o777, 0o700);
  });

  test("clear before anything was written creates nothing and leaves other files alone", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "bystander.txt"), "keep");
    await new Cache({ token: TOKEN, cacheDir: dir }).clear();
    assert.deepEqual(await readdir(dir), ["bystander.txt"]);
  });
});

describe("unsafe cache directories", { skip: process.platform === "win32" }, () => {
  const planted = { fetchedAt: 1_000_000_000_000, data: "from the link target" };

  /** A directory holding a valid-looking entry for key "k", to prove it is neither read nor written. */
  async function target(): Promise<string> {
    const dir = await tempDir();
    await chmod(dir, 0o755);
    await writeFile(join(dir, "k.json"), JSON.stringify(planted));
    return dir;
  }

  test("a token directory that is a symlink is not used: the value is still returned and the target is untouched", async () => {
    const dir = await tempDir();
    const elsewhere = await target();
    await mkdir(join(dir, "unlinked"), { mode: 0o700 });
    await symlink(elsewhere, join(dir, "unlinked", TOKEN_NAMESPACE));
    const cache = new Cache({ token: TOKEN, cacheDir: dir, now: () => 1_000_000_000_000 });
    const result = await cache.get("k", async () => "fresh");
    assert.equal(result.value, "fresh");
    assert.deepEqual(await readdir(elsewhere), ["k.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(elsewhere, "k.json"), "utf8")), planted);
    assert.equal((await stat(elsewhere)).mode & 0o777, 0o755);
  });

  test("a base directory that is a symlink is not used either", async () => {
    const dir = await tempDir();
    const elsewhere = await target();
    await mkdir(join(elsewhere, TOKEN_NAMESPACE));
    await writeFile(join(elsewhere, TOKEN_NAMESPACE, "k.json"), JSON.stringify(planted));
    await symlink(elsewhere, join(dir, "unlinked"));
    const result = await new Cache({ token: TOKEN, cacheDir: dir, now: () => 1_000_000_000_000 }).get("k", async () => "fresh");
    assert.equal(result.value, "fresh");
    assert.deepEqual((await readdir(elsewhere)).sort(), [TOKEN_NAMESPACE, "k.json"]);
    assert.deepEqual(await readdir(join(elsewhere, TOKEN_NAMESPACE)), ["k.json"]);
    assert.equal((await stat(elsewhere)).mode & 0o777, 0o755);
  });

  test("a directory owned by another user is not used", { skip: typeof process.getuid !== "function" }, async (t) => {
    const dir = await tempDir();
    const cache = new Cache({ token: TOKEN, cacheDir: dir, now: () => 1_000_000_000_000 });
    await cache.get("first", async () => 1);
    assert.deepEqual(await readdir(join(dir, "unlinked", TOKEN_NAMESPACE)), ["first.json"]);
    const mine = process.getuid!();
    t.mock.method(process as { getuid(): number }, "getuid", () => mine + 1);
    const { state, load } = counter("fresh");
    const again = await new Cache({ token: TOKEN, cacheDir: dir, now: () => 1_000_000_000_000 }).get("first", load);
    assert.equal(again.value, "fresh");
    assert.equal(state.calls, 1);
    await new Cache({ token: TOKEN, cacheDir: dir, now: () => 1_000_000_000_000 }).get("second", async () => 2);
    assert.deepEqual(await readdir(join(dir, "unlinked", TOKEN_NAMESPACE)), ["first.json"]);
  });
});

describe("defaultCacheDir", () => {
  test("follows platform conventions", () => {
    assert.equal(defaultCacheDir({ platform: "darwin", env: {}, home: "/Users/a" }), "/Users/a/Library/Caches");
    assert.equal(defaultCacheDir({ platform: "linux", env: {}, home: "/home/a" }), "/home/a/.cache");
    assert.equal(defaultCacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "/x" }, home: "/home/a" }), "/x");
    assert.equal(
      defaultCacheDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\u" }),
      "C:\\L",
    );
    assert.equal(defaultCacheDir({ platform: "win32", env: {}, home: "C:\\u" }), "C:\\u\\AppData\\Local");
  });

  test("an absolute env path is used after trimming", () => {
    assert.equal(defaultCacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "  /x/cache \n" }, home: "/home/a" }), "/x/cache");
    assert.equal(defaultCacheDir({ platform: "win32", env: { LOCALAPPDATA: " C:\\L " }, home: "C:\\u" }), "C:\\L");
  });

  test("a relative or blank XDG_CACHE_HOME is ignored (it would land under the cwd)", () => {
    for (const value of ["cache", "./cache", "../cache", "", "   ", "\t\n"]) {
      assert.equal(defaultCacheDir({ platform: "linux", env: { XDG_CACHE_HOME: value }, home: "/home/a" }), "/home/a/.cache", JSON.stringify(value));
    }
  });

  test("a relative or blank LOCALAPPDATA is ignored", () => {
    for (const value of ["AppData", ".\\cache", "", "  "]) {
      assert.equal(defaultCacheDir({ platform: "win32", env: { LOCALAPPDATA: value }, home: "C:\\u" }), "C:\\u\\AppData\\Local", JSON.stringify(value));
    }
  });

  test("no absolute home and no usable env path means no disk cache at all (undefined), never a cwd path", () => {
    for (const home of ["", "  ", "relative/home", "."]) {
      assert.equal(defaultCacheDir({ platform: "linux", env: {}, home }), undefined, `linux ${JSON.stringify(home)}`);
      assert.equal(defaultCacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "rel" }, home }), undefined, `linux rel ${JSON.stringify(home)}`);
      assert.equal(defaultCacheDir({ platform: "darwin", env: {}, home }), undefined, `darwin ${JSON.stringify(home)}`);
      assert.equal(defaultCacheDir({ platform: "win32", env: {}, home }), undefined, `win32 ${JSON.stringify(home)}`);
    }
  });

  test("a valid env path still works when the home is unusable", () => {
    assert.equal(defaultCacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "/x" }, home: "" }), "/x");
    assert.equal(defaultCacheDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "" }), "C:\\L");
  });
});

describe("stale temp files", () => {
  const hash = TOKEN_NAMESPACE;
  const ago = (ms: number) => new Date(Date.now() - ms);

  async function seed(dir: string, otherToken = false) {
    const tokenDir = join(dir, "unlinked", hash);
    const otherDir = join(dir, "unlinked", "0123456789abcdef");
    await mkdir(tokenDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    const files: Array<[string, number]> = [
      [join(tokenDir, "snapshot_A.json.1234.abcd.tmp"), 2 * HOUR],
      [join(tokenDir, "snapshot_B.json.1234.beef.tmp"), HOUR + MIN],
      [join(tokenDir, "snapshot_C.json.1234.cafe.tmp"), 30 * MIN],
      [join(tokenDir, "snapshot_D.json"), 5 * HOUR],
      [join(otherDir, "snapshot_E.json.1.aa.tmp"), 5 * HOUR],
    ];
    for (const [file, age] of files) {
      await writeFile(file, "x");
      await utimes(file, ago(age), ago(age));
    }
    return { tokenDir, otherDir };
  }

  test("tmp files older than an hour are removed when the disk cache is first used; younger ones and real entries stay", async () => {
    const dir = await tempDir();
    const { tokenDir, otherDir } = await seed(dir);
    const cache = new Cache({ token: TOKEN, cacheDir: dir });
    assert.deepEqual((await readdir(tokenDir)).length, 4, "nothing happens before first use");
    await cache.get("fresh-key", async () => "v");
    assert.deepEqual((await readdir(tokenDir)).sort(), ["fresh-key.json", "snapshot_C.json.1234.cafe.tmp", "snapshot_D.json"]);
    assert.deepEqual(await readdir(otherDir), ["snapshot_E.json.1.aa.tmp"], "another token's directory is not touched");
  });

  test("the sweep also runs when the first use is a cache hit read", async () => {
    const dir = await tempDir();
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "v");
    const { tokenDir } = await seed(dir);
    await new Cache({ token: TOKEN, cacheDir: dir }).get("k", async () => "never");
    assert.ok(!(await readdir(tokenDir)).includes("snapshot_A.json.1234.abcd.tmp"));
  });

  test("the sweep runs once per cache instance, not on every read", async () => {
    const dir = await tempDir();
    const cache = new Cache({ token: TOKEN, cacheDir: dir });
    await cache.get("a", async () => 1);
    const { tokenDir } = await seed(dir);
    await cache.get("b", async () => 2);
    assert.ok((await readdir(tokenDir)).includes("snapshot_A.json.1234.abcd.tmp"));
  });

  test("a sweep with no directory to sweep never throws", async () => {
    const dir = await tempDir();
    assert.equal((await new Cache({ token: TOKEN, cacheDir: join(dir, "missing", "deeper") }).get("k", async () => "v")).value, "v");
  });

  test("a cache directory that is really a file: reads, sweep and write fail quietly, the loader value is returned, the file is untouched", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "i am a file");
    const cache = new Cache({ token: TOKEN, cacheDir: blocker });
    assert.equal((await cache.get("k", async () => "v")).value, "v");
    assert.equal(await readFile(blocker, "utf8"), "i am a file");
    assert.deepEqual(await readdir(dir), ["blocker"]);
  });

  test("a memory-only cache and ttl 0 touch no files", async () => {
    const dir = await tempDir();
    const { tokenDir } = await seed(dir);
    await new Cache({ token: TOKEN }).get("k", async () => "v");
    await new Cache({ token: TOKEN, cacheDir: dir, ttlMs: 0 }).get("k", async () => "v");
    assert.equal((await readdir(tokenDir)).length, 4);
  });
});
