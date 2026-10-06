import { buildFeedLink, collapseText, formatUtc, linkPostUrn, linkTarget, resolveLocalized } from "./normalize.js";

/** A changelog event reduced to what merging needs. Plain JSON, safe to cache. */
export type CleanEvent = {
  activityId: string;
  capturedAt: number;
  method: string;
  resourceName: string;
  resourceId?: string;
  resourceUri?: string;
  activity: Record<string, unknown>;
};

type Obj = Record<string, unknown>;

const MAX_EPOCH_MS = 8.64e15;
const IGNORED_RESOURCES = new Set(["messages", "invitations"]);

const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Unwraps `{patch: {$set: {...}}}` and resolves `{localized: ...}` values to plain strings. */
function cleanActivity(raw: unknown): Obj {
  let activity = isObj(raw) ? raw : {};
  const patch = activity.patch;
  if (isObj(patch) && isObj(patch.$set)) {
    activity = patch.$set;
  }
  // fromEntries defines own properties, so a "__proto__" key cannot swap the result's prototype the way `result[key] =` would.
  return Object.fromEntries(
    Object.entries(activity).map(([key, value]) => {
      const resolved = isObj(value) && "localized" in value ? resolveLocalized(value) : undefined;
      return [key, resolved ?? value];
    }),
  );
}

const INTRO_SOURCE_KEYS = ["headline", "summary", "firstName", "lastName"];
const PROFILE_TEXT_KEYS = ["description", "title", "name", "summary", "text", "degreeName", "schoolName", "companyName", "notes"];

const pickStrings = (activity: Obj, keys: readonly string[]): Obj =>
  Object.fromEntries(keys.filter((key) => typeof activity[key] === "string").map((key) => [key, activity[key]]));

/** Keeps only the activity fields the merge rules and the activity feed read, per resource. */
function pickActivity(resourceName: string, activity: Obj): Obj | undefined {
  if (resourceName === "people") {
    return pickStrings(activity, INTRO_SOURCE_KEYS);
  }
  // Only the known résumé collections: other people/<x> resources (contact details and so on) are dropped.
  if (profileCollection(resourceName)) {
    return pickStrings(activity, PROFILE_TEXT_KEYS);
  }
  if (resourceName === "socialActions/likes") {
    return pickStrings(activity, ["object", "reactionType"]);
  }
  if (resourceName === "socialActions/comments") {
    const text = isObj(activity.message) ? activity.message.text : undefined;
    return {
      ...pickStrings(activity, ["id", "object"]),
      ...(activity.id !== undefined && typeof activity.id !== "string" ? { id: String(activity.id) } : {}),
      ...(typeof text === "string" ? { message: { text } } : {}),
    };
  }
  if (resourceName === "ugcPosts") {
    const commentary = postCommentary(activity);
    const visibility = postVisibility(activity);
    return {
      ...pickStrings(activity, ["id"]),
      ...(commentary === undefined ? {} : { specificContent: { [UGC_CONTENT]: { shareCommentary: { text: commentary } } } }),
      ...(visibility === undefined ? {} : { visibility: { [UGC_VISIBILITY]: visibility } }),
    };
  }
  return undefined;
}

/**
 * Normalizes raw changelog events: drops inbox/invitation events, keeps the last non-FAILURE record per
 * `activityId` (so a FAILURE followed by a replay applies once) and orders by `capturedAt`.
 */
export function cleanChangelog(rawEvents: readonly unknown[]): CleanEvent[] {
  const byActivity = new Map<string, CleanEvent>();
  rawEvents.forEach((raw, index) => {
    if (!isObj(raw)) {
      return;
    }
    const { resourceName, method, capturedAt } = raw;
    if (
      typeof resourceName !== "string" ||
      typeof method !== "string" ||
      typeof capturedAt !== "number" ||
      !Number.isFinite(capturedAt) ||
      Math.abs(capturedAt) > MAX_EPOCH_MS || // beyond the Date range: formatting it would throw
      IGNORED_RESOURCES.has(resourceName) ||
      raw.activityStatus === "FAILURE"
    ) {
      return;
    }
    const activity = pickActivity(resourceName, cleanActivity(raw.activity));
    if (activity === undefined) {
      return;
    }
    const activityId = raw.activityId === undefined ? `index-${index}` : String(raw.activityId);
    byActivity.set(activityId, {
      activityId,
      capturedAt,
      method,
      resourceName,
      ...(raw.resourceId === undefined ? {} : { resourceId: String(raw.resourceId) }),
      ...(typeof raw.resourceUri === "string" ? { resourceUri: raw.resourceUri } : {}),
      activity,
    });
  });
  return [...byActivity.values()].sort((a, b) => a.capturedAt - b.capturedAt);
}

export type MergeResult<T> = { items: T[]; applied: number };

const INTRO_FIELDS: Record<string, string> = {
  headline: "headline",
  summary: "about",
  firstName: "firstName",
  lastName: "lastName",
};

const isUpdate = (event: CleanEvent) => event.method === "PARTIAL_UPDATE" || event.method === "UPDATE";

/** Applies `people` edits (headline, summary, names) over the snapshot intro. Latest event wins. */
export function mergeIntro(
  intro: Record<string, unknown> | undefined,
  events: readonly CleanEvent[],
): { intro: Record<string, unknown> | undefined; applied: number } {
  const next: Record<string, unknown> = { ...(intro ?? {}) };
  let applied = 0;
  for (const event of events) {
    if (event.resourceName !== "people" || !isUpdate(event)) {
      continue;
    }
    for (const [source, target] of Object.entries(INTRO_FIELDS)) {
      const value = event.activity[source];
      if (typeof value === "string" && value.trim() !== "" && next[target] !== value) {
        next[target] = value;
        applied += 1;
      }
    }
  }
  const hasData = Object.keys(next).length > 0;
  return { intro: hasData ? next : intro, applied };
}

const newestFirst = <T extends Record<string, unknown>>(items: T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const da = String(a.item.date ?? "");
      const db = String(b.item.date ?? "");
      return da === db ? a.index - b.index : da < db ? 1 : -1;
    })
    .map(({ item }) => item);

const tryDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Pulls the `<urn>` out of `/socialActions/<urn>/<kind>/...`. */
function socialActionTarget(resourceUri: string | undefined, kind: "likes" | "comments"): string | undefined {
  const match = resourceUri?.match(new RegExp(`^/socialActions/(.+)/${kind}/[^/]+$`));
  return match?.[1] ? tryDecode(match[1]) : undefined;
}

export type ReactionItem = { date: string; type: string; link: string } & Record<string, unknown>;

/** Adds reactions the snapshot has not caught up with yet, and removes ones that were undone. */
export function mergeReactions(
  rows: readonly ReactionItem[],
  events: readonly CleanEvent[],
): MergeResult<ReactionItem> {
  const items = [...rows];
  let applied = 0;
  // target URN -> the rows pointing at it, in item order. Built once so each event costs O(1), not O(rows).
  const byTarget = new Map<string, ReactionItem[]>();
  const track = (row: ReactionItem) => {
    const target = linkTarget(String(row.link));
    if (target === undefined) {
      return;
    }
    const list = byTarget.get(target);
    if (list) {
      list.push(row);
    } else {
      byTarget.set(target, [row]);
    }
  };
  items.forEach(track);

  for (const event of events) {
    if (event.resourceName !== "socialActions/likes") {
      continue;
    }
    if (event.method === "CREATE") {
      const object = event.activity.object;
      if (typeof object !== "string" || byTarget.has(object)) {
        continue;
      }
      const type = typeof event.activity.reactionType === "string" ? event.activity.reactionType : "LIKE";
      const row: ReactionItem = { date: formatUtc(event.capturedAt), type, link: buildFeedLink(object) };
      items.push(row);
      track(row);
      applied += 1;
    } else if (event.method === "DELETE") {
      const object = socialActionTarget(event.resourceUri, "likes") ?? event.activity.object;
      const list = typeof object === "string" ? byTarget.get(object) : undefined;
      const row = list?.shift();
      if (row !== undefined) {
        items.splice(items.indexOf(row), 1);
        if (list!.length === 0) {
          byTarget.delete(object as string);
        }
        applied += 1;
      }
    }
  }
  return { items: newestFirst(items), applied };
}

export type CommentItem = { date: string; link: string; message: string } & Record<string, unknown>;

const commentKey = (link: string, message: string) => `${linkPostUrn(link) ?? link}\u0000${collapseText(message)}`;

/** The post a comment belongs to: `object` itself, or the parent post of a reply's comment URN. */
function postUrnOf(object: string): string {
  const match = object.match(/^urn:li:comment:\((urn:li:)?([^,]+),/);
  return match ? `urn:li:${match[2]}` : object;
}

function commentUrnFor(object: string, id: string): string {
  return object.startsWith("urn:li:comment:") ? object : `urn:li:comment:(${object.replace(/^urn:li:/, "")},${id})`;
}

function commentId(event: CleanEvent): string | undefined {
  const fromUri = event.resourceUri?.match(/\/comments\/([^/]+)$/)?.[1];
  const id = event.activity.id ?? event.resourceId ?? fromUri;
  return id === undefined ? undefined : String(id);
}

/**
 * Adds comments the snapshot has not caught up with. Snapshot comments carry no ids, so UPDATE and DELETE
 * only apply to comments that this merge itself added.
 */
export function mergeComments(
  rows: readonly CommentItem[],
  events: readonly CleanEvent[],
): MergeResult<CommentItem> {
  const items = [...rows];
  const added = new Map<string, CommentItem>();
  // How many rows carry each (post, text) key, so duplicate checks cost O(1) per event.
  const keyCounts = new Map<string, number>();
  const bump = (key: string, by: number) => keyCounts.set(key, (keyCounts.get(key) ?? 0) + by);
  const keyOf = (row: CommentItem) => commentKey(String(row.link), String(row.message ?? ""));
  items.forEach((row) => bump(keyOf(row), 1));
  let applied = 0;

  for (const event of events) {
    if (event.resourceName !== "socialActions/comments") {
      continue;
    }
    const id = commentId(event);
    if (event.method === "CREATE") {
      const { object } = event.activity;
      const text = (event.activity.message as { text?: unknown } | undefined)?.text;
      if (id === undefined || typeof object !== "string" || typeof text !== "string" || text.trim() === "") {
        continue;
      }
      const link = buildFeedLink(postUrnOf(object));
      const key = commentKey(link, text);
      if ((keyCounts.get(key) ?? 0) > 0) {
        continue;
      }
      const item: CommentItem = { date: formatUtc(event.capturedAt), link, message: text };
      items.push(item);
      bump(key, 1);
      added.set(id, item);
      applied += 1;
    } else if (id !== undefined && added.has(id)) {
      const item = added.get(id)!;
      if (event.method === "DELETE") {
        items.splice(items.indexOf(item), 1);
        bump(keyOf(item), -1);
        added.delete(id);
        applied += 1;
      } else if (event.method === "UPDATE" || event.method === "PARTIAL_UPDATE") {
        const text = (event.activity.message as { text?: unknown } | undefined)?.text;
        if (typeof text === "string" && text.trim() !== "" && text !== item.message) {
          bump(keyOf(item), -1);
          item.message = text;
          bump(keyOf(item), 1);
          applied += 1;
        }
      }
    }
  }
  return { items: newestFirst(items), applied };
}

export type PostItem = { date: string; shareLink: string } & Record<string, unknown>;

const UGC_CONTENT = "com.linkedin.ugc.ShareContent";
const UGC_VISIBILITY = "com.linkedin.ugc.MemberNetworkVisibility";
const POST_URN = /^urn:li:(ugcPost|share):/;

function postUrn(event: CleanEvent): string | undefined {
  const candidates = [event.resourceId, event.activity.id];
  return candidates.find((value): value is string => typeof value === "string" && POST_URN.test(value));
}

function postCommentary(activity: Obj): string | undefined {
  const content = activity.specificContent;
  const shareContent = isObj(content) ? content[UGC_CONTENT] : undefined;
  const commentary = isObj(shareContent) ? shareContent.shareCommentary : undefined;
  const text = isObj(commentary) ? commentary.text : undefined;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

function postVisibility(activity: Obj): string | undefined {
  const visibility = isObj(activity.visibility) ? activity.visibility[UGC_VISIBILITY] : undefined;
  return typeof visibility === "string" && visibility !== "" ? visibility : undefined;
}

/**
 * Adds posts from `ugcPosts` events (shape taken from LinkedIn's UGC docs; not yet seen live) unless the
 * snapshot already has the same URN or the same commentary. DELETE removes on an exact URN match only.
 */
export function mergePosts(rows: readonly PostItem[], events: readonly CleanEvent[]): MergeResult<PostItem> {
  const items = [...rows];
  let applied = 0;
  // Lookup tables built once: rows by post URN, and how many rows carry each folded commentary.
  const byUrn = new Map<string, PostItem[]>();
  const commentaryCounts = new Map<string, number>();
  const foldedOf = (row: PostItem) => collapseText(String(row.shareCommentary ?? ""));
  const track = (row: PostItem) => {
    const urn = linkTarget(String(row.shareLink));
    if (urn !== undefined) {
      byUrn.set(urn, [...(byUrn.get(urn) ?? []), row]);
    }
    const folded = foldedOf(row);
    if (folded !== "") {
      commentaryCounts.set(folded, (commentaryCounts.get(folded) ?? 0) + 1);
    }
  };
  items.forEach(track);

  for (const event of events) {
    if (event.resourceName !== "ugcPosts") {
      continue;
    }
    const urn = postUrn(event);
    if (urn === undefined) {
      continue;
    }
    if (event.method === "CREATE") {
      const commentary = postCommentary(event.activity);
      const folded = collapseText(commentary);
      if (byUrn.has(urn) || (folded !== "" && (commentaryCounts.get(folded) ?? 0) > 0)) {
        continue;
      }
      const visibility = postVisibility(event.activity);
      const row: PostItem = {
        date: formatUtc(event.capturedAt),
        shareLink: buildFeedLink(urn),
        ...(commentary === undefined ? {} : { shareCommentary: commentary }),
        ...(visibility === undefined ? {} : { visibility }),
      };
      items.push(row);
      track(row);
      applied += 1;
    } else if (event.method === "DELETE") {
      const [row, ...rest] = byUrn.get(urn) ?? [];
      if (row !== undefined) {
        items.splice(items.indexOf(row), 1);
        if (rest.length > 0) {
          byUrn.set(urn, rest);
        } else {
          byUrn.delete(urn);
        }
        const folded = foldedOf(row);
        if (folded !== "") {
          commentaryCounts.set(folded, (commentaryCounts.get(folded) ?? 1) - 1);
        }
        applied += 1;
      }
    }
  }
  return { items: newestFirst(items), applied };
}

/** `people/<collection>` changelog resources and the section each one feeds. */
const PROFILE_COLLECTIONS: Record<string, { section: string; noun: string }> = {
  positions: { section: "experience", noun: "Position" },
  educations: { section: "education", noun: "Education" },
  skills: { section: "skills", noun: "Skill" },
  certifications: { section: "certifications", noun: "Certification" },
  projects: { section: "projects", noun: "Project" },
  languages: { section: "languages", noun: "Language" },
  honors: { section: "honors", noun: "Honor" },
  courses: { section: "courses", noun: "Course" },
  publications: { section: "publications", noun: "Publication" },
  patents: { section: "patents", noun: "Patent" },
  volunteerExperiences: { section: "volunteering", noun: "Volunteering entry" },
  organizations: { section: "organizations", noun: "Organization" },
};

function profileCollection(resourceName: string): { section: string; noun: string } | undefined {
  const match = resourceName.match(/^people\/([^/]+)$/);
  return match?.[1] ? PROFILE_COLLECTIONS[match[1]] : undefined;
}

const EDITED_TEXT_KEYS = ["description", "title", "name", "summary", "text", "degreeName", "schoolName", "companyName", "notes"];

const squash = (value: string) => collapseText(value).replace(/\s+/g, "");

/**
 * Sections with recent profile-collection edits (e.g. a position description) that no snapshot row reflects
 * yet. Rows have no ids, so these edits cannot be merged; this is a value check, not a timestamp check.
 */
export function findPendingEdits(
  events: readonly CleanEvent[],
  rowsBySection: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>,
): string[] {
  const latest = new Map<string, CleanEvent>();
  for (const event of events) {
    if (profileCollection(event.resourceName)) {
      latest.set(`${event.resourceName}\u0000${event.resourceId ?? event.activityId}`, event);
    }
  }

  const pending = new Set<string>();
  for (const event of latest.values()) {
    const section = profileCollection(event.resourceName)!.section;
    const rows = rowsBySection[section];
    if (!rows || event.method === "DELETE" || pending.has(section)) {
      continue;
    }
    const known = new Set(
      rows.flatMap((row) => Object.values(row).filter((v): v is string => typeof v === "string").map(squash)),
    );
    const edited = EDITED_TEXT_KEYS.map((key) => event.activity[key]).filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (edited.some((text) => !known.has(squash(text)))) {
      pending.add(section);
    }
  }
  return [...pending];
}

export type FeedItem = {
  at: string;
  section: string;
  change: "added" | "edited" | "removed";
  summary: string;
};

const CHANGE_BY_METHOD: Record<string, FeedItem["change"]> = {
  CREATE: "added",
  UPDATE: "edited",
  PARTIAL_UPDATE: "edited",
  DELETE: "removed",
};

const INTRO_FEED_LABELS: Array<[string[], string]> = [
  [["headline"], "Headline updated"],
  [["summary"], "About updated"],
  [["firstName", "lastName"], "Name updated"],
];

function feedItemsFor(event: CleanEvent): Array<Omit<FeedItem, "at">> {
  const change = CHANGE_BY_METHOD[event.method];
  if (change === undefined) {
    return [];
  }
  const { activity } = event;

  if (event.resourceName === "people") {
    if (change !== "edited") {
      return [];
    }
    return INTRO_FEED_LABELS.filter(([keys]) => keys.some((key) => typeof activity[key] === "string")).map(
      ([, summary]) => ({ section: "intro", change, summary }),
    );
  }

  const collection = profileCollection(event.resourceName);
  if (collection) {
    const field = EDITED_TEXT_KEYS.find((key) => typeof activity[key] === "string");
    const verb = change === "edited" && field ? `${field} edited` : change;
    return [{ section: collection.section, change, summary: `${collection.noun} ${verb}` }];
  }

  if (event.resourceName === "socialActions/likes") {
    const object = socialActionTarget(event.resourceUri, "likes") ?? activity.object;
    if (typeof object !== "string") {
      return [];
    }
    const link = buildFeedLink(object);
    const type = typeof activity.reactionType === "string" ? activity.reactionType : "LIKE";
    return [
      {
        section: "reactions",
        change,
        summary: change === "removed" ? `Reaction removed ${link}` : `${type} ${link}`,
      },
    ];
  }

  if (event.resourceName === "socialActions/comments") {
    const id = commentId(event);
    const object = socialActionTarget(event.resourceUri, "comments") ?? activity.object;
    if (id === undefined || typeof object !== "string") {
      return [];
    }
    const link = buildFeedLink(commentUrnFor(object, id));
    const text = (activity.message as { text?: unknown } | undefined)?.text;
    const label = typeof text === "string" && text.trim() !== "" ? text : change === "removed" ? "Comment removed" : "Comment";
    return [{ section: "comments", change, summary: `${label} ${link}` }];
  }

  if (event.resourceName === "ugcPosts") {
    const urn = postUrn(event);
    if (urn === undefined) {
      return [];
    }
    const label = postCommentary(activity) ?? (change === "removed" ? "Post removed" : "Post");
    return [{ section: "posts", change, summary: `${label} ${buildFeedLink(urn)}` }];
  }

  return [];
}

/** Recent changes as a flat, newest-first feed. Contains no raw payloads or LinkedIn resource names. */
export function buildActivityFeed(events: readonly CleanEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const event of events) {
    const at = new Date(event.capturedAt).toISOString();
    for (const item of feedItemsFor(event)) {
      items.push({ at, ...item });
    }
  }
  return items.reverse();
}
