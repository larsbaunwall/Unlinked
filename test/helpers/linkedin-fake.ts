import { jsonResponse } from "./fake-fetch.js";

export type LinkedInFakeOptions = {
  /** Rows per LinkedIn domain. Domains not listed answer 404, like an empty domain. */
  snapshots?: Record<string, unknown[]>;
  /** Raw changelog events (single page). */
  events?: unknown[];
  /** Make the changelog answer this HTTP status instead of events. */
  changelogStatus?: number;
  /** Make every snapshot page that has data point at a next page, forever (hits the page cap, forces truncation). */
  snapshotEndless?: boolean;
  /** Make every changelog page point at a next page (forces truncation). */
  changelogEndless?: boolean;
  /** Elements returned by memberAuthorizations. */
  authorizations?: unknown[];
};

/** Routes fake LinkedIn REST calls by path. Records every request URL. No network. */
export function linkedinFake(options: LinkedInFakeOptions = {}) {
  const urls: URL[] = [];
  const authorizations: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.pathname === "/rest/memberSnapshotData") {
      const domain = url.searchParams.get("domain") ?? "";
      const rows = options.snapshots?.[domain];
      if (!rows) {
        return jsonResponse(404, { message: "No data found for this domain and memberId.", status: 404 });
      }
      const links = options.snapshotEndless
        ? [{ rel: "next", href: `https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=${domain}&start=10` }]
        : [];
      return jsonResponse(200, {
        elements: [{ snapshotDomain: domain, snapshotData: rows }],
        paging: { start: 0, count: 10, links, total: 1 },
      });
    }
    if (url.pathname === "/rest/memberChangeLogs") {
      if (options.changelogStatus) {
        return jsonResponse(options.changelogStatus, { message: "denied", status: options.changelogStatus });
      }
      const next = options.changelogEndless
        ? [{ rel: "next", href: "https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication&start=50" }]
        : [];
      return jsonResponse(200, { elements: options.events ?? [], paging: { start: 0, count: 50, links: next, total: 0 } });
    }
    if (url.pathname === "/rest/memberAuthorizations") {
      return jsonResponse(200, { elements: options.authorizations ?? [] });
    }
    return jsonResponse(500, { message: `unexpected ${url.pathname}` });
  }) as typeof fetch;

  return {
    impl,
    urls,
    /** The Authorization header of every request, in order. */
    authorizations,
    /** Snapshot domains requested so far, in order. */
    domains: () =>
      urls.filter((u) => u.pathname === "/rest/memberSnapshotData").map((u) => u.searchParams.get("domain") ?? ""),
    changelogRequests: () => urls.filter((u) => u.pathname === "/rest/memberChangeLogs").length,
  };
}
