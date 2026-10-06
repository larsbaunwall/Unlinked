import type { Cache, Cached } from "./cache.js";
import { LinkedInApiError, type LinkedInClient } from "./linkedin/client.js";
import {
  buildActivityFeed,
  cleanChangelog,
  findPendingEdits,
  mergeComments,
  mergeIntro,
  mergePosts,
  mergeReactions,
  type CleanEvent,
  type CommentItem,
  type FeedItem,
  type PostItem,
  type ReactionItem,
} from "./linkedin/merge.js";
import { dedupeRows, normalizeRow, type Row } from "./linkedin/normalize.js";
import {
  DEFAULT_PROFILE_SECTIONS,
  RESUME_SECTIONS,
  UNBOUNDED_SECTIONS,
  SECTIONS,
  jsonKey,
  lookupSection,
  type SectionDef,
} from "./linkedin/sections.js";

/** The caller asked for something that cannot work (unknown/blocked section, bad cursor, bad `since`). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const DAY = 86_400_000;
const CHANGELOG_WINDOW_MS = 28 * DAY;
/** Stay a little inside LinkedIn's 28 day window so `startTime` is never rejected as too old. */
const CHANGELOG_MARGIN_MS = 5 * 60_000;
const DEFAULT_PAGE_SIZE = 50;

export type Freshness = {
  /** When the oldest input used for this answer was fetched from LinkedIn (ISO). */
  asOf: string;
  /** Number of recent changes applied on top of the snapshot. */
  recentChangesMerged: number;
  /** Sections with recent edits that LinkedIn's snapshot does not show yet and that cannot be merged. */
  pendingEdits: string[];
  /** Sections for which LinkedIn returned no data (no entries, or not prepared yet). */
  empty: string[];
  /** True when LinkedIn had more data than could be fetched (page cap reached). */
  incomplete?: true;
  /** Set when the recent-changes lookup failed; the snapshot is still returned. */
  recentChangesError?: string;
};

export type RelatedLink = { section: string; label: string };
export type ProfileResult = { [section: string]: unknown; related: RelatedLink[]; freshness: Freshness };

export type SectionPage = {
  section: string;
  label: string;
  note?: string;
  items: unknown[];
  total: number;
  nextCursor?: string;
  freshness: Freshness;
};

export type ActivityPage = {
  since: string;
  items: FeedItem[];
  total: number;
  nextCursor?: string;
  freshness: { asOf: string; incomplete?: true };
};

export type AccessStatus = { connected: boolean; trackingChangesSince?: string };

type SnapshotEntry = { rows: Row[]; empty: boolean; truncated: boolean };
type ChangelogEntry = { events: CleanEvent[]; truncated: boolean };

const isSnapshotEntry = (value: unknown): value is SnapshotEntry =>
  isObj(value) &&
  Array.isArray(value.rows) &&
  value.rows.every(isObj) &&
  typeof value.empty === "boolean" &&
  typeof value.truncated === "boolean";

const isChangelogEntry = (value: unknown): value is ChangelogEntry =>
  isObj(value) &&
  typeof value.truncated === "boolean" &&
  Array.isArray(value.events) &&
  value.events.every(
    (event) =>
      isObj(event) &&
      typeof event.activityId === "string" &&
      typeof event.capturedAt === "number" &&
      typeof event.method === "string" &&
      typeof event.resourceName === "string" &&
      isObj(event.activity),
  );

export type ServiceOptions = {
  client: LinkedInClient;
  cache: Cache;
  accessToken: string;
  now?: () => number;
};

export type Service = ReturnType<typeof createService>;

const isObj = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);

function applyRenames(row: Row, renames: SectionDef["renames"]): Row {
  if (!renames) {
    return row;
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [Object.hasOwn(renames, key) ? renames[key]! : key, value]));
}

/** `scope` ties a cursor to the section (or the activity feed) that issued it. */
type CursorPayload = { scope: string; offset: number; asOf: number; since?: number };

const encodeCursor = (payload: CursorPayload): string => Buffer.from(JSON.stringify(payload)).toString("base64url");

function decodeCursor(cursor: string, scope: string): CursorPayload {
  const invalid = () => new UsageError("Invalid cursor. Use the nextCursor value from the previous page.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!isObj(parsed)) {
    throw invalid();
  }
  const { offset, asOf, since, scope: issuedFor } = parsed;
  if (typeof issuedFor !== "string") {
    throw invalid();
  }
  if (issuedFor !== scope) {
    throw new UsageError(
      `This cursor came from a different request ("${issuedFor}"), not "${scope}". Use the nextCursor from the previous page of the same request.`,
    );
  }
  if (!Number.isInteger(offset) || (offset as number) < 0 || typeof asOf !== "number" || !Number.isFinite(asOf)) {
    throw invalid();
  }
  // A `since` beyond the Date range would make toISOString throw a RangeError later.
  if (since !== undefined && (typeof since !== "number" || !Number.isFinite(since) || Math.abs(since) > MAX_EPOCH_MS)) {
    throw invalid();
  }
  return { scope, offset: offset as number, asOf, ...(since === undefined ? {} : { since }) };
}

/** Format and scope check for a cursor, with no fetch. Lets callers reject a bad cursor before they need a token. */
export function checkCursor(cursor: string | undefined, scope: string): void {
  if (cursor !== undefined) {
    decodeCursor(cursor, scope);
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (Number.isNaN(limit) || limit < 1) {
    throw new UsageError("limit must be a whole number of 1 or more.");
  }
  return Math.floor(limit);
}

const STALE_CURSOR = "The data changed, restart from first page (the cursor was issued before a refresh).";

function paginate<T>(
  all: readonly T[],
  {
    limit,
    cursor,
    asOf,
    since,
    scope,
    consistent,
  }: { limit: number; cursor?: string; asOf: number; since?: number; scope: string; consistent: boolean },
): { items: T[]; total: number; nextCursor?: string } {
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor, scope);
    // With the cache off every call refetches, so asOf always differs and cannot detect a refresh.
    if (consistent && decoded.asOf !== asOf) {
      throw new UsageError(STALE_CURSOR);
    }
    offset = decoded.offset;
  }
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    items,
    total: all.length,
    ...(next < all.length ? { nextCursor: encodeCursor({ scope, offset: next, asOf, ...(since === undefined ? {} : { since }) }) } : {}),
  };
}

const RELATIVE_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };

const MAX_EPOCH_MS = 8.64e15;
const SINCE_HELP = "Use a duration like 7d or 12h, an ISO date, or epoch milliseconds.";

/** True when `YYYY-MM-DD` at the start of `text` is a real calendar date (Date.parse rolls 02-30 into March). */
function hasRealCalendarDate(text: string): boolean {
  const [year, month, day] = text.slice(0, 10).split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/** `7d`, `12h`, an ISO date/time, or epoch milliseconds. Defaults to the full 28 day changelog window. */
export function parseSince(value: string | undefined, now: number): number {
  const text = value?.trim() ?? "";
  if (text === "") {
    return now - CHANGELOG_WINDOW_MS;
  }
  const invalid = (hint = SINCE_HELP) => new UsageError(`Invalid since value "${text}". ${hint}`);

  let result: number | undefined;
  const relative = text.match(/^(\d+)([mhdw])$/i);
  if (relative) {
    result = now - Number(relative[1]) * RELATIVE_UNITS[relative[2]!.toLowerCase()]!;
  } else if (/^\d{12,}$/.test(text)) {
    result = Number(text);
  } else if (/^\d{9,11}$/.test(text)) {
    throw invalid("That looks like epoch seconds; give epoch milliseconds (13 digits) instead, or a duration like 7d.");
  } else if (/^\d{4}-\d{2}-\d{2}/.test(text) && hasRealCalendarDate(text)) {
    result = Date.parse(text);
  }
  // NaN and anything beyond the Date range would make toISOString throw later.
  if (result === undefined || !Number.isFinite(result) || Math.abs(result) > MAX_EPOCH_MS) {
    throw invalid();
  }
  return result;
}

/** Looks up a section by id. Blocked and unknown sections are usage errors. */
export function resolveSection(name: string): SectionDef {
  const lookup = lookupSection(name);
  if (lookup.status === "blocked") {
    throw new UsageError(`The "${name}" section is not available: it holds sensitive data that Unlinked never reads.`);
  }
  if (lookup.status === "unknown") {
    throw new UsageError(`Unknown section "${name}". Available sections: ${SECTIONS.map((s) => s.id).join(", ")}.`);
  }
  return lookup.section;
}

/** The sections a profile call embeds: everything small (`all`), the requested ones, or the default six. */
export function resolveProfileSections({ sections, all }: { sections?: readonly string[]; all?: boolean } = {}): readonly SectionDef[] {
  if (all) {
    if (sections && sections.length > 0) {
      throw new UsageError("all and sections cannot be combined: use all for every résumé section, or list the ones you want.");
    }
    return RESUME_SECTIONS;
  }
  if (sections && sections.length > 0) {
    const resolved = [...new Set(sections.map((name) => resolveSection(name)))];
    const paged = resolved.find((section) => section.kind === "unbounded");
    if (paged) {
      throw new UsageError(
        `"${paged.id}" can be large, so it is not part of the profile. Request it on its own as a section.`,
      );
    }
    return resolved;
  }
  return DEFAULT_PROFILE_SECTIONS;
}

export function createService({ client, cache, accessToken, now = Date.now }: ServiceOptions) {
  const snapshot = (section: SectionDef, refresh?: boolean): Promise<Cached<SnapshotEntry>> =>
    cache.get<SnapshotEntry>(
      `snapshot:${section.id}`,
      async () => {
        const result = await client.getSnapshotDomain({ accessToken, domain: section.domain });
        const rows = dedupeRows(
          result.snapshotData
            .filter(isObj)
            .map((row) => normalizeRow(row, section.redactions))
            .filter((row) => Object.keys(row).length > 0),
        );
        return { rows, empty: result.empty, truncated: result.truncated };
      },
      { refresh, isEmpty: (entry) => entry.empty, validate: isSnapshotEntry },
    );

  const changelog = (refresh?: boolean): Promise<Cached<ChangelogEntry>> =>
    cache.get<ChangelogEntry>(
      "changelog:28d",
      async () => {
        const result = await client.getChangelog({
          accessToken,
          startTime: now() - CHANGELOG_WINDOW_MS + CHANGELOG_MARGIN_MS,
        });
        return { events: cleanChangelog(result.events), truncated: result.truncated };
      },
      { refresh, validate: isChangelogEntry },
    );

  /** The changelog is an enhancement for profile and section calls: its failure must not hide the snapshot. */
  async function tryChangelog(refresh?: boolean): Promise<{ entry?: Cached<ChangelogEntry>; error?: string }> {
    try {
      return { entry: await changelog(refresh) };
    } catch (error) {
      if (error instanceof LinkedInApiError) {
        return { error: error.message };
      }
      throw error;
    }
  }

  function freshnessOf(parts: {
    fetchedAts: number[];
    applied: number;
    pendingEdits: string[];
    empty: string[];
    truncated: boolean;
    changelogError?: string;
  }): Freshness {
    return {
      asOf: new Date(Math.min(...parts.fetchedAts)).toISOString(),
      recentChangesMerged: parts.applied,
      pendingEdits: parts.pendingEdits,
      empty: parts.empty,
      ...(parts.truncated ? { incomplete: true as const } : {}),
      ...(parts.changelogError === undefined ? {} : { recentChangesError: parts.changelogError }),
    };
  }

  const introOf = (rows: Row[], section: SectionDef): Row | undefined =>
    rows[0] ? applyRenames(rows[0], section.renames) : undefined;

  return {
    async getProfile({
      sections,
      all,
      refresh,
    }: { sections?: readonly string[]; all?: boolean; refresh?: boolean } = {}): Promise<ProfileResult> {
      const selected = resolveProfileSections({ sections, all });

      const [entries, changes] = await Promise.all([
        Promise.all(selected.map((section) => snapshot(section, refresh))),
        tryChangelog(refresh),
      ]);
      const events = changes.entry?.value.events ?? [];

      const result: Record<string, unknown> = {};
      const rowsBySection: Record<string, Row[]> = {};
      const empty: string[] = [];
      let applied = 0;

      selected.forEach((section, index) => {
        const { rows, empty: isEmpty } = entries[index]!.value;
        rowsBySection[section.id] = rows;
        if (section.single) {
          const merged = mergeIntro(introOf(rows, section), events);
          applied += merged.applied;
          if (merged.intro) {
            result[jsonKey(section.id)] = merged.intro;
          } else {
            empty.push(section.id);
          }
          return;
        }
        result[jsonKey(section.id)] = rows.map((row) => applyRenames(row, section.renames));
        if (isEmpty) {
          empty.push(section.id);
        }
      });

      const related: RelatedLink[] = UNBOUNDED_SECTIONS.map(({ id, label }) => ({ section: id, label }));
      const freshness = freshnessOf({
        fetchedAts: [...entries.map((entry) => entry.fetchedAt), ...(changes.entry ? [changes.entry.fetchedAt] : [])],
        applied,
        pendingEdits: findPendingEdits(events, rowsBySection),
        empty,
        truncated: Boolean(changes.entry?.value.truncated) || entries.some((entry) => entry.value.truncated),
        changelogError: changes.error,
      });
      return { ...result, related, freshness };
    },

    async getSection({
      section: name,
      limit,
      cursor,
      refresh,
    }: { section: string; limit?: number; cursor?: string; refresh?: boolean }): Promise<SectionPage> {
      const section = resolveSection(name);
      const pageSize = normalizeLimit(limit);
      if (cursor !== undefined) {
        decodeCursor(cursor, section.id); // format check before any fetch; the stale-asOf check happens after
      }
      const usesChangelog = section.merge !== undefined || section.kind === "bounded";

      const [entry, changes] = await Promise.all([
        snapshot(section, refresh),
        usesChangelog ? tryChangelog(refresh) : Promise.resolve<{ entry?: Cached<ChangelogEntry>; error?: string }>({}),
      ]);
      const events = changes.entry?.value.events ?? [];
      const rows = entry.value.rows;

      let items: Row[];
      let applied = 0;
      switch (section.merge) {
        case "intro": {
          const merged = mergeIntro(introOf(rows, section), events);
          items = merged.intro ? [merged.intro] : [];
          applied = merged.applied;
          break;
        }
        case "reactions": {
          const merged = mergeReactions(rows as ReactionItem[], events);
          items = merged.items;
          applied = merged.applied;
          break;
        }
        case "comments": {
          const merged = mergeComments(rows as CommentItem[], events);
          items = merged.items;
          applied = merged.applied;
          break;
        }
        case "posts": {
          const merged = mergePosts(rows as PostItem[], events);
          items = merged.items;
          applied = merged.applied;
          break;
        }
        default:
          items = rows.map((row) => applyRenames(row, section.renames));
      }

      const asOf = Math.min(entry.fetchedAt, ...(changes.entry ? [changes.entry.fetchedAt] : []));
      const page = paginate(items, { limit: pageSize, cursor, asOf, scope: section.id, consistent: cache.enabled });
      // Merged-in changelog items count: a section the snapshot has not caught up with is not empty.
      const isEmpty = items.length === 0 && (section.single || entry.value.empty);
      return {
        section: section.id,
        label: section.label,
        ...(section.note === undefined ? {} : { note: section.note }),
        ...page,
        freshness: freshnessOf({
          fetchedAts: [asOf],
          applied,
          pendingEdits: findPendingEdits(events, { [section.id]: rows }),
          empty: isEmpty ? [section.id] : [],
          truncated: Boolean(changes.entry?.value.truncated) || entry.value.truncated,
          changelogError: changes.error,
        }),
      };
    },

    async getRecentActivity({
      since,
      limit,
      cursor,
      refresh,
    }: { since?: string; limit?: number; cursor?: string; refresh?: boolean } = {}): Promise<ActivityPage> {
      const pageSize = normalizeLimit(limit);
      // A cursor pins `since`, so a relative value like "7d" cannot drift between pages.
      const pinned = cursor === undefined ? undefined : decodeCursor(cursor, "activity").since;
      const sinceMs = pinned ?? parseSince(since, now());

      const entry = await changelog(refresh);
      const feed = buildActivityFeed(entry.value.events.filter((event) => event.capturedAt >= sinceMs));
      const page = paginate(feed, { limit: pageSize, cursor, asOf: entry.fetchedAt, since: sinceMs, scope: "activity", consistent: cache.enabled });
      return {
        since: new Date(sinceMs).toISOString(),
        ...page,
        freshness: {
          asOf: new Date(entry.fetchedAt).toISOString(),
          ...(entry.value.truncated ? { incomplete: true as const } : {}),
        },
      };
    },

    async checkAccess(): Promise<AccessStatus> {
      const status = await client.getAuthorizationStatus({ accessToken });
      const elements = Array.isArray(status.elements) ? status.elements.filter(isObj) : [];
      const created = elements
        .map((element) => element.regulatedAt)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      return {
        connected: elements.length > 0,
        ...(created.length > 0 ? { trackingChangesSince: new Date(Math.min(...created)).toISOString() } : {}),
      };
    },
  };
}
