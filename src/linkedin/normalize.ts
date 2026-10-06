/** Helpers that turn LinkedIn's export-style rows into tidy, camelCase records. */

export type Row = Record<string, unknown>;

/** "First Name" -> "firstName", "Date/Time" -> "dateTime", "ShareLink" -> "shareLink". */
export function toCamelKey(key: string): string | undefined {
  const words = key.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }
  return words
    .map((word, index) => {
      const normalized = word.length > 1 && word === word.toUpperCase() ? word.toLowerCase() : word;
      const head = index === 0 ? normalized.charAt(0).toLowerCase() : normalized.charAt(0).toUpperCase();
      return head + normalized.slice(1);
    })
    .join("");
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

export function normalizeRow(row: Row, redactions: readonly string[] = []): Row {
  const redacted = new Set(redactions);
  const result: Row = {};
  for (const [rawKey, value] of Object.entries(row)) {
    const key = toCamelKey(rawKey);
    if (key === undefined || redacted.has(key) || isEmptyValue(value)) {
      continue;
    }
    if (Object.hasOwn(result, key)) {
      // Two source keys camelCase to the same name (e.g. "First Name" and "first_name"): keep both.
      if (canonicalJson(result[key]) === canonicalJson(value)) {
        continue;
      }
      let suffix = 2;
      while (Object.hasOwn(result, `${key}${suffix}`) || Object.hasOwn(row, `${key}${suffix}`)) {
        suffix += 1;
      }
      result[`${key}${suffix}`] = value;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Row)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function dedupeRows<T>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = canonicalJson(row);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(row);
    }
  }
  return result;
}

/** Resolves LinkedIn's `{localized: {en_US: "x" | {rawText: "x"}}}` shapes (or a plain string). */
export function resolveLocalized(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Row;
  const localized = record.localized;
  if (localized === null || typeof localized !== "object") {
    return undefined;
  }
  const map = localized as Row;
  const locale = record.preferredLocale as { country?: unknown; language?: unknown } | undefined;
  const preferredKey =
    locale && typeof locale.language === "string" && typeof locale.country === "string"
      ? `${locale.language}_${locale.country}`
      : undefined;
  const candidate = preferredKey !== undefined && preferredKey in map ? map[preferredKey] : Object.values(map)[0];
  if (typeof candidate === "string") {
    return candidate;
  }
  if (candidate !== null && typeof candidate === "object" && typeof (candidate as Row).rawText === "string") {
    return (candidate as Row).rawText as string;
  }
  return undefined;
}

/** Whitespace-collapsed, case-folded text used for comparisons. */
export function collapseText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Epoch ms -> "YYYY-MM-DD HH:MM:SS" in UTC, the format of snapshot dates. */
export function formatUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace("T", " ");
}

const FEED_PREFIX = "https://www.linkedin.com/feed/update/";

function encodeUrn(urn: string): string {
  return encodeURIComponent(urn).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function pathUrn(url: URL): string | undefined {
  if (!url.pathname.startsWith("/feed/update/")) {
    return undefined;
  }
  try {
    const urn = decodeURIComponent(url.pathname.slice("/feed/update/".length)).replace(/\/+$/, "");
    return urn.startsWith("urn:") ? urn : undefined;
  } catch {
    return undefined;
  }
}

function parseFeedLink(link: string): URL | undefined {
  try {
    return new URL(link);
  } catch {
    return undefined;
  }
}

/** The post URN in a feed link's path, ignoring any `commentUrn` parameter. */
export function linkPostUrn(link: string): string | undefined {
  const url = parseFeedLink(link);
  return url ? pathUrn(url) : undefined;
}

/** The URN a feed link points at: the `commentUrn` parameter if present, otherwise the path URN. */
export function linkTarget(link: string): string | undefined {
  const url = parseFeedLink(link);
  if (!url || !url.pathname.startsWith("/feed/update/")) {
    return undefined;
  }
  return url.searchParams.get("commentUrn") || pathUrn(url);
}

/** Builds a feed link in the snapshot's form. A comment URN links to its parent post plus `commentUrn`. */
export function buildFeedLink(urn: string): string {
  const commentPrefix = "urn:li:comment:(";
  if (urn.startsWith(commentPrefix) && urn.endsWith(")")) {
    const inner = urn.slice(commentPrefix.length, urn.lastIndexOf(","));
    const parent = inner.startsWith("urn:") ? inner : `urn:li:${inner}`;
    return `${FEED_PREFIX}${encodeUrn(parent)}?commentUrn=${encodeUrn(urn)}`;
  }
  return `${FEED_PREFIX}${encodeUrn(urn)}`;
}
