import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { LinkedInApiError, LinkedInClient } from "../src/linkedin/client.js";
import { fakeFetch, jsonResponse } from "./helpers/fake-fetch.js";

const TOKEN = "test-token-123";
const notFound = () =>
  jsonResponse(404, { message: "No data found for this domain and memberId.", status: 404 });

function snapshotPage(rows: unknown[], next?: string) {
  return {
    elements: [{ snapshotDomain: "POSITIONS", snapshotData: rows }],
    paging: { start: 0, count: 10, links: next ? [{ rel: "next", href: next }] : [], total: 1 },
  };
}

function client(responders: Parameters<typeof fakeFetch>[0], maxRetries = 0) {
  const fetch = fakeFetch(responders);
  return { fetch, client: new LinkedInClient({ fetchImpl: fetch.impl, maxRetries }) };
}

describe("getSnapshotDomain", () => {
  test("sends the pinned version header, bearer token and domain query", async () => {
    const { fetch, client: c } = client([() => jsonResponse(200, snapshotPage([{ Title: "A" }]))]);
    const result = await c.getSnapshotDomain({ accessToken: TOKEN, domain: "POSITIONS" });
    assert.deepEqual(result.snapshotData, [{ Title: "A" }]);
    assert.equal(result.empty, false);
    const call = fetch.calls[0]!;
    assert.equal(call.headers["linkedin-version"], "202312");
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    const url = new URL(call.url);
    assert.equal(url.pathname, "/rest/memberSnapshotData");
    assert.equal(url.searchParams.get("q"), "criteria");
    assert.equal(url.searchParams.get("domain"), "POSITIONS");
  });

  test("a 404 on page 1 is an empty result", async () => {
    const { client: c } = client([notFound]);
    const result = await c.getSnapshotDomain({ accessToken: TOKEN, domain: "HONORS" });
    assert.equal(result.empty, true);
    assert.deepEqual(result.snapshotData, []);
    assert.equal(result.truncated, false);
  });

  test("a 404 on page 2 ends the data and keeps page 1 rows", async () => {
    const { client: c } = client([
      () => jsonResponse(200, snapshotPage([{ Title: "A" }], "https://api.linkedin.com/rest/memberSnapshotData?q=criteria&start=1")),
      notFound,
    ]);
    const result = await c.getSnapshotDomain({ accessToken: TOKEN, domain: "POSITIONS" });
    assert.deepEqual(result.snapshotData, [{ Title: "A" }]);
    assert.equal(result.empty, false);
    assert.equal(result.truncated, false);
    assert.equal(result.pageCount, 1);
  });

  test("stops after 50 pages and flags truncation", async () => {
    const { fetch, client: c } = client([
      () => jsonResponse(200, snapshotPage([{ n: 1 }], "https://api.linkedin.com/rest/memberSnapshotData?q=criteria&start=1")),
    ]);
    const result = await c.getSnapshotDomain({ accessToken: TOKEN, domain: "ALL_LIKES" });
    assert.equal(fetch.calls.length, 50);
    assert.equal(result.pageCount, 50);
    assert.equal(result.truncated, true);
  });

  test("other errors propagate as LinkedInApiError without internal terms", async () => {
    const { client: c } = client([() => jsonResponse(400, { message: "domain is not supported", status: 400 })]);
    await assert.rejects(c.getSnapshotDomain({ accessToken: TOKEN, domain: "EVENTS" }), (error: unknown) => {
      assert.ok(error instanceof LinkedInApiError);
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message.split("domain is not supported")[0]!, /domain/i);
      return true;
    });
  });
});

describe("error messages", () => {
  test("version errors do not point at a removed setting", async () => {
    const { client: c } = client([() => jsonResponse(426, { message: "nope" })]);
    await assert.rejects(c.getSnapshotDomain({ accessToken: TOKEN, domain: "POSITIONS" }), (error: unknown) => {
      assert.ok(error instanceof LinkedInApiError);
      assert.doesNotMatch(error.message, /LINKEDIN_API_VERSION/);
      return true;
    });
  });
});

describe("getChangelog", () => {
  const eventPage = (processedAt: number[], next?: string) => ({
    elements: processedAt.map((p) => ({ id: p, processedAt: p })),
    paging: { start: 0, count: 50, links: next ? [{ rel: "next", href: next }] : [], total: 0 },
  });

  test("follows next links and reports the latest processedAt", async () => {
    const { fetch, client: c } = client([
      () => jsonResponse(200, eventPage([1, 2], "https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication&start=50")),
      () => jsonResponse(200, eventPage([3])),
    ]);
    const result = await c.getChangelog({ accessToken: TOKEN, startTime: 5 });
    assert.equal(result.events.length, 3);
    assert.equal(result.pageCount, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.nextStartTime, 3);
    const first = new URL(fetch.calls[0]!.url);
    assert.equal(first.searchParams.get("q"), "memberAndApplication");
    assert.equal(first.searchParams.get("startTime"), "5");
    assert.equal(first.searchParams.get("count"), "50");
    assert.equal(fetch.calls[0]!.headers["linkedin-version"], "202312");
  });

  test("caps at 40 pages and flags truncation", async () => {
    const { fetch, client: c } = client([
      () => jsonResponse(200, eventPage([1], "https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication&start=1")),
    ]);
    const result = await c.getChangelog({ accessToken: TOKEN });
    assert.equal(fetch.calls.length, 40);
    assert.equal(result.truncated, true);
  });
});

describe("getChangelog strictness", () => {
  test("a 404 is an error, not an empty result", async () => {
    const { client: c } = client([notFound]);
    await assert.rejects(c.getChangelog({ accessToken: TOKEN }), (error: unknown) => {
      assert.ok(error instanceof LinkedInApiError);
      assert.equal(error.status, 404);
      return true;
    });
  });

  test("a 404 on a later page is an error too", async () => {
    const page = { elements: [{ id: 1, processedAt: 1 }], paging: { links: [{ rel: "next", href: "https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication&start=50" }] } };
    const { client: c } = client([() => jsonResponse(200, page), notFound]);
    await assert.rejects(c.getChangelog({ accessToken: TOKEN }), LinkedInApiError);
  });

  test("an undefined startTime is left out of the request instead of being sent as the text 'undefined'", async () => {
    const { fetch, client: c } = client([() => jsonResponse(200, { elements: [] })]);
    await c.getChangelog({ accessToken: TOKEN });
    const url = new URL(fetch.calls[0]!.url);
    assert.equal(url.searchParams.has("startTime"), false);
    assert.equal(url.search, "?q=memberAndApplication&count=50");
  });

  test("clamps count to 1..50", async () => {
    for (const [input, expected] of [[500, "50"], [0, "1"], [-3, "1"], [7, "7"]] as const) {
      const { fetch, client: c } = client([() => jsonResponse(200, { elements: [] })]);
      await c.getChangelog({ accessToken: TOKEN, count: input });
      assert.equal(new URL(fetch.calls[0]!.url).searchParams.get("count"), expected, String(input));
    }
  });
});

describe("getAuthorizationStatus", () => {
  test("a 404 is an error", async () => {
    const { client: c } = client([notFound]);
    await assert.rejects(c.getAuthorizationStatus({ accessToken: TOKEN }), LinkedInApiError);
  });

  test("queries memberAuthorizations with the pinned version", async () => {
    const { fetch, client: c } = client([() => jsonResponse(200, { elements: [{ id: "x" }] })]);
    const result = await c.getAuthorizationStatus({ accessToken: TOKEN });
    assert.deepEqual(result.elements, [{ id: "x" }]);
    const url = new URL(fetch.calls[0]!.url);
    assert.equal(url.pathname, "/rest/memberAuthorizations");
    assert.equal(url.searchParams.get("q"), "memberAndApplication");
    assert.equal(fetch.calls[0]!.headers["linkedin-version"], "202312");
  });
});

describe("request id", () => {
  const failWith = async (headers: Record<string, string>) => {
    const { client: c } = client([() => jsonResponse(403, { message: "denied" }, headers)]);
    return c.getAuthorizationStatus({ accessToken: TOKEN }).then(
      () => assert.fail("should have been rejected"),
      (error: unknown) => {
        assert.ok(error instanceof LinkedInApiError);
        return error;
      },
    );
  };

  test("x-li-uuid is the request id", async () => {
    assert.equal((await failWith({ "x-li-uuid": "uuid-1" })).requestId, "uuid-1");
  });

  test("x-restli-id and x-li-fabric are fallbacks, in that order", async () => {
    assert.equal((await failWith({ "x-restli-id": "restli-1", "x-li-fabric": "fabric-1" })).requestId, "restli-1");
    assert.equal((await failWith({ "x-li-fabric": "fabric-1" })).requestId, "fabric-1");
    assert.equal((await failWith({ "x-li-uuid": "uuid-1", "x-restli-id": "restli-1", "x-li-fabric": "fabric-1" })).requestId, "uuid-1");
  });

  test("no header means no request id", async () => {
    assert.equal((await failWith({})).requestId, undefined);
  });

  test("a 200 that is not JSON also carries it", async () => {
    const { client: c } = client([() => new Response("<html>", { status: 200, headers: { "x-li-uuid": "uuid-2" } })]);
    await assert.rejects(c.getAuthorizationStatus({ accessToken: TOKEN }), (error: unknown) => {
      assert.ok(error instanceof LinkedInApiError);
      assert.equal(error.requestId, "uuid-2");
      return true;
    });
  });
});

describe("the request-time host and https guard", () => {
  test("a client built with a plain http base URL refuses to send anything", async () => {
    const fetch = fakeFetch([() => jsonResponse(200, { elements: [] })]);
    const c = new LinkedInClient({ baseUrl: "http://api.linkedin.com", fetchImpl: fetch.impl, maxRetries: 0 });
    for (const call of [
      () => c.getAuthorizationStatus({ accessToken: TOKEN }),
      () => c.getSnapshotDomain({ accessToken: TOKEN, domain: "SKILLS" }),
      () => c.getChangelog({ accessToken: TOKEN }),
    ]) {
      await assert.rejects(call(), (error: unknown) => {
        assert.ok(error instanceof LinkedInApiError);
        assert.equal(error.status, 0);
        assert.match(error.message, /^Refusing to send request to unexpected host "api\.linkedin\.com"\. Expected "api\.linkedin\.com"\.$/);
        return true;
      });
    }
    assert.equal(fetch.calls.length, 0);
  });
});
