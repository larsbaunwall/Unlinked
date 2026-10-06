import {
  LINKEDIN_API_BASE_URL,
  LINKEDIN_API_VERSION,
  type AuthorizationStatusResult,
  type ChangelogResult,
  type JsonObject,
  type LinkedInAuth,
  type SnapshotDomainResult,
} from "./types.js";

export type LinkedInClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  requestTimeoutMs?: number;
  /** Max retry attempts for transient failures (429 / 5xx / network errors). Defaults to 3. */
  maxRetries?: number;
  /** Injectable clock and sleep, so retry behaviour can be tested without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type PagedLinkedInResult = {
  elements: unknown[];
  pageCount: number;
  truncated: boolean;
};

type LinkedInSnapshotElement = {
  snapshotDomain?: string;
  snapshotData?: unknown[];
  [key: string]: unknown;
};

export class LinkedInApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly serviceErrorCode?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "LinkedInApiError";
  }
}

const SNAPSHOT_MAX_PAGES = 50;
const CHANGELOG_MAX_PAGES = 40;
const CHANGELOG_PAGE_SIZE = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
/** Longest error text we pass on from LinkedIn (a proxy error page can be huge). */
const MAX_MESSAGE_CHARS = 300;

export class LinkedInClient {
  readonly #baseUrl: string;
  readonly #allowedHost: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor({
    baseUrl = LINKEDIN_API_BASE_URL,
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    now = Date.now,
    sleep = defaultSleep,
  }: LinkedInClientOptions = {}) {
    this.#now = now;
    this.#sleep = sleep;
    this.#baseUrl = baseUrl;
    this.#allowedHost = new URL(baseUrl).host;
    this.#fetch = fetchImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxRetries = maxRetries;
  }

  /**
   * Fetches every page of one snapshot domain. A 404 on the first page means "no data (yet)" and is
   * reported as `empty`; a 404 on a later page just ends the data and keeps the rows fetched so far.
   */
  async getSnapshotDomain({
    accessToken,
    domain,
    maxPages = SNAPSHOT_MAX_PAGES,
  }: LinkedInAuth & { domain: string; maxPages?: number }): Promise<SnapshotDomainResult> {
    const result = await this.getPaged(
      this.buildUrl("/rest/memberSnapshotData", { q: "criteria", domain }),
      accessToken,
      maxPages,
      { notFoundIsEmpty: true },
    );

    const snapshotData = result.elements.flatMap((element) => {
      const snapshotElement = asJsonObject(element) as LinkedInSnapshotElement;
      return Array.isArray(snapshotElement.snapshotData) ? snapshotElement.snapshotData : [];
    });

    return {
      domain,
      snapshotData,
      rawElements: result.elements,
      pageCount: result.pageCount,
      truncated: result.truncated,
      empty: result.pageCount === 0,
    };
  }

  async getChangelog({
    accessToken,
    startTime,
    count = CHANGELOG_PAGE_SIZE,
    maxPages = CHANGELOG_MAX_PAGES,
  }: LinkedInAuth & { startTime?: number; count?: number; maxPages?: number }): Promise<ChangelogResult> {
    const result = await this.getPaged(
      this.buildUrl("/rest/memberChangeLogs", {
        q: "memberAndApplication",
        startTime,
        count: Math.min(CHANGELOG_PAGE_SIZE, Math.max(1, Math.trunc(count) || 1)),
      }),
      accessToken,
      maxPages,
    );
    const processedAtValues = result.elements
      .map((element) => asJsonObject(element).processedAt)
      .filter((processedAt): processedAt is number => typeof processedAt === "number");
    const nextStartTime = processedAtValues.length > 0 ? Math.max(...processedAtValues) : startTime;

    return {
      events: result.elements,
      ...(nextStartTime === undefined ? {} : { nextStartTime }),
      pageCount: result.pageCount,
      truncated: result.truncated,
    };
  }

  async getAuthorizationStatus({ accessToken }: LinkedInAuth): Promise<AuthorizationStatusResult> {
    return this.getJson(this.buildUrl("/rest/memberAuthorizations", { q: "memberAndApplication" }), accessToken);
  }

  private buildUrl(pathname: string, query: Record<string, string | number | undefined> = {}): URL {
    const url = new URL(pathname, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  /** `notFoundIsEmpty` (snapshot calls only): a 404 means "no data" / "end of data" instead of an error. */
  private async getPaged(
    url: URL,
    accessToken: string,
    maxPages: number,
    { notFoundIsEmpty = false }: { notFoundIsEmpty?: boolean } = {},
  ): Promise<PagedLinkedInResult> {
    const elements: unknown[] = [];
    let currentUrl: URL | undefined = url;
    let pageCount = 0;

    while (currentUrl && pageCount < maxPages) {
      let responseJson: JsonObject;
      try {
        responseJson = await this.getJson(currentUrl, accessToken);
      } catch (error) {
        // For snapshots a 404 means "nothing here": an empty first page, or simply the end of the data.
        if (notFoundIsEmpty && error instanceof LinkedInApiError && error.status === 404) {
          return { elements, pageCount, truncated: false };
        }
        throw error;
      }
      elements.push(...asElements(responseJson));
      pageCount += 1;
      currentUrl = getNextPageUrl(responseJson, this.#baseUrl, this.#allowedHost);
    }

    return {
      elements,
      pageCount,
      truncated: Boolean(currentUrl),
    };
  }

  private async getJson(url: URL, accessToken: string): Promise<JsonObject> {
    // Defense in depth: never send the bearer token to a host other than the configured LinkedIn API.
    if (url.protocol !== "https:" || url.host !== this.#allowedHost) {
      throw new LinkedInApiError(
        `Refusing to send request to unexpected host "${url.host}". Expected "${this.#allowedHost}".`,
        0,
      );
    }

    // A token that cannot be a header value would make fetch throw an error that may quote it.
    if (!/^[\x21-\x7E]+$/.test(accessToken)) {
      throw new LinkedInApiError(
        "The LinkedIn access token contains spaces, line breaks or non-ASCII characters, so it cannot be sent. Check LINKEDIN_TOKEN.",
        0,
      );
    }
    const scrub = (text: string): string => text.split(accessToken).join("[token]");

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        const response = await this.#fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Linkedin-Version": LINKEDIN_API_VERSION,
            "Content-Type": "application/json",
          },
          // A redirect would carry the bearer token to wherever it points; fail instead of following it.
          redirect: "error",
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
        const { json: responseJson, isJson } = await parseLinkedInResponse(response);

        if (response.ok) {
          if (!isJson) {
            throw new LinkedInApiError(
              `LinkedIn sent an unexpected response (HTTP ${response.status}, not a JSON object). Retry later.`,
              response.status,
              undefined,
              getRequestId(response.headers),
            );
          }
          return responseJson;
        }

        const rawMessage =
          typeof responseJson.message === "string" && isJson ? responseJson.message : response.statusText || `HTTP ${response.status}`;
        const message = scrub(rawMessage).slice(0, MAX_MESSAGE_CHARS);
        const serviceErrorCode =
          typeof responseJson.serviceErrorCode === "number" ? responseJson.serviceErrorCode : undefined;
        const retryable = isRetryableStatus(response.status);
        const delay = retryable ? getRetryDelayMs(attempt, response.headers.get("retry-after"), this.#now()) : 0;
        // A wait longer than we are willing to sleep (a quota window) is reported instead of retried.
        const tooLong = retryable && delay > RETRY_MAX_DELAY_MS;
        const waitHint = tooLong ? ` Retry after about ${formatWait(delay)}.` : "";
        const apiError = new LinkedInApiError(
          withWaitHint(getLinkedInFailureMessage(response.status, message), waitHint),
          response.status,
          serviceErrorCode,
          getRequestId(response.headers),
        );

        if (!retryable || tooLong || attempt === this.#maxRetries) {
          throw apiError;
        }
        lastError = apiError;
        await this.#sleep(delay);
        continue;
      } catch (error) {
        if (error instanceof LinkedInApiError) {
          throw error;
        }
        // Network error / timeout — retry if attempts remain.
        lastError = error;
        if (attempt === this.#maxRetries) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new LinkedInApiError(`LinkedIn request failed: ${scrub(reason).slice(0, MAX_MESSAGE_CHARS)}`, 0);
        }
        await this.#sleep(getRetryDelayMs(attempt, null, this.#now()));
      }
    }
    // Unreachable, but keeps the type-checker happy.
    throw lastError instanceof Error ? lastError : new Error("LinkedIn request failed");
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** Milliseconds to wait before retrying. May exceed the cap when LinkedIn asks for a long wait. */
function getRetryDelayMs(attempt: number, retryAfterHeader: string | null, now: number): number {
  const header = retryAfterHeader?.trim();
  if (header) {
    if (/^\d+$/.test(header)) {
      return Number(header) * 1000;
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - now);
    }
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function asJsonObject(value: unknown): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function asElements(responseJson: JsonObject): unknown[] {
  const elements = responseJson.elements;
  return Array.isArray(elements) ? elements : [];
}

function getNextPageUrl(responseJson: JsonObject, baseUrl: string, allowedHost: string): URL | undefined {
  const paging = asJsonObject(responseJson.paging);
  const links = paging.links;
  if (!Array.isArray(links)) {
    return undefined;
  }

  const nextLink = links.find((link) => asJsonObject(link).rel === "next");
  const href = asJsonObject(nextLink).href;
  if (typeof href !== "string") {
    return undefined;
  }

  // Defense in depth: ignore any "next" link that points off the LinkedIn API host so we never
  // send the bearer token to an attacker-controlled URL if a response is tampered with.
  let nextUrl: URL;
  try {
    nextUrl = new URL(href, baseUrl);
  } catch {
    return undefined;
  }
  if (nextUrl.protocol !== "https:" || nextUrl.host !== allowedHost) {
    return undefined;
  }
  return nextUrl;
}

function getRequestId(headers: Headers): string | undefined {
  return headers.get("x-li-uuid") ?? headers.get("x-restli-id") ?? headers.get("x-li-fabric") ?? undefined;
}

function getLinkedInFailureMessage(status: number, message: string): string {
  const suffix = "Member Data Portability is currently available only to LinkedIn members in the EEA and Switzerland.";

  switch (status) {
    case 400:
      return `LinkedIn rejected the request as invalid. Check the requested section, timestamp, count, or query parameters. ${message}`;
    case 401:
      return `LinkedIn rejected the access token. It may be missing, expired, revoked, invalid, or malformed. ${message}`;
    case 403:
      return `LinkedIn denied access. Confirm the developer app has the Member Data Portability API (Member) product, the token has a DMA portability scope such as r_dma_portability_self_serve, and member consent is active. ${suffix} ${message}`;
    case 404:
      return `LinkedIn found no data for this request, or the API is restricted for this application. ${message}`;
    case 426:
      return `LinkedIn rejected the API version this tool sends. Update to the latest release. ${message}`;
    case 429:
      return `LinkedIn rate-limited the request. Retry later and reduce duplicate calls. ${message}`;
    default:
      if (status >= 500) {
        return `LinkedIn returned a server-side failure or timeout. Retry later. ${message}`;
      }
      return `LinkedIn returned HTTP ${status}. ${message}`;
  }
}

/** `isJson` is true when the body was empty or a JSON object; HTML, arrays and scalars are not. */
async function parseLinkedInResponse(response: Response): Promise<{ json: JsonObject; isJson: boolean }> {
  const text = await response.text();
  if (!text.trim()) {
    return { json: {}, isJson: true };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { json: parsed as JsonObject, isJson: true };
    }
  } catch {
    // Not JSON.
  }
  return { json: {}, isJson: false };
}

/** Appends the wait hint on its own sentence, whether or not the message already ends with punctuation. */
function withWaitHint(message: string, waitHint: string): string {
  if (!waitHint) return message;
  const trimmed = message.trimEnd();
  return `${/[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`}${waitHint}`;
}
