import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { LinkedInApiError, LinkedInClient } from "../src/linkedin/client.js";
import { fakeFetch, jsonResponse, type Responder } from "./helpers/fake-fetch.js";

const TOKEN = "tok-9f8e7d6c5b4a-synthetic";
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const page = (rows: unknown[], next?: string) => ({
  elements: [{ snapshotDomain: "POSITIONS", snapshotData: rows }],
  paging: { links: next ? [{ rel: "next", href: next }] : [] },
});

/** A client whose sleeps are recorded instead of waited for. */
function setup(responders: Responder[], maxRetries = 3) {
  const fetch = fakeFetch(responders);
  const sleeps: number[] = [];
  const client = new LinkedInClient({
    fetchImpl: fetch.impl,
    maxRetries,
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { fetch, sleeps, client };
}
const snapshot = (c: LinkedInClient) => c.getSnapshotDomain({ accessToken: TOKEN, domain: "POSITIONS" });

describe("retry policy", () => {
  test("client errors other than 408/429 are never retried", async () => {
    for (const status of [400, 401, 403, 404, 426]) {
      const { fetch, sleeps, client } = setup([() => jsonResponse(status, { message: "no" })]);
      await assert.rejects(client.getAuthorizationStatus({ accessToken: TOKEN }), (e: unknown) => e instanceof LinkedInApiError && e.status === status);
      assert.equal(fetch.calls.length, 1, String(status));
      assert.deepEqual(sleeps, [], String(status));
    }
  });

  test("a persistent 503 is tried 1 + maxRetries times, then fails with its status", async () => {
    const { fetch, sleeps, client } = setup([() => jsonResponse(503, { message: "busy" })], 3);
    await assert.rejects(snapshot(client), (e: unknown) => e instanceof LinkedInApiError && e.status === 503);
    assert.equal(fetch.calls.length, 4);
    assert.equal(sleeps.length, 3);
  });

  test("a 408 is retried: one more call, one sleep", async () => {
    const { fetch, sleeps, client } = setup([() => jsonResponse(408, { message: "timeout" }), () => jsonResponse(200, page([{ a: 1 }]))]);
    assert.equal((await snapshot(client)).snapshotData.length, 1);
    assert.equal(fetch.calls.length, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! >= 500 && sleeps[0]! < 1000, String(sleeps[0]));
  });

  test("backoff grows exponentially without Retry-After", async () => {
    const { sleeps, client } = setup([() => jsonResponse(500, {})], 3);
    await assert.rejects(snapshot(client));
    assert.ok(sleeps[0]! >= 500 && sleeps[0]! < 1000, String(sleeps[0]));
    assert.ok(sleeps[1]! >= 1000 && sleeps[1]! < 1500, String(sleeps[1]));
    assert.ok(sleeps[2]! >= 2000 && sleeps[2]! < 2500, String(sleeps[2]));
  });

  test("Retry-After in seconds is honoured", async () => {
    const { sleeps, client } = setup([() => jsonResponse(429, {}, { "retry-after": "2" }), () => jsonResponse(200, page([{ a: 1 }]))]);
    assert.equal((await snapshot(client)).snapshotData.length, 1);
    assert.deepEqual(sleeps, [2000]);
  });

  test("Retry-After as an HTTP date is honoured relative to now", async () => {
    const date = new Date(NOW + 3000).toUTCString();
    const { sleeps, client } = setup([() => jsonResponse(429, {}, { "retry-after": date }), () => jsonResponse(200, page([{ a: 1 }]))]);
    await snapshot(client);
    assert.deepEqual(sleeps, [3000]);
  });

  test("a Retry-After date in the past retries immediately; garbage falls back to backoff", async () => {
    const past = new Date(NOW - 60_000).toUTCString();
    const a = setup([() => jsonResponse(503, {}, { "retry-after": past }), () => jsonResponse(200, page([]))]);
    await snapshot(a.client);
    assert.deepEqual(a.sleeps, [0]);
    const b = setup([() => jsonResponse(503, {}, { "retry-after": "soon" }), () => jsonResponse(200, page([]))]);
    await snapshot(b.client);
    assert.ok(b.sleeps[0]! >= 500 && b.sleeps[0]! < 1000);
  });

  test("a Retry-After longer than the wait cap fails fast and says how long to wait", async () => {
    const { fetch, sleeps, client } = setup([() => jsonResponse(429, { message: "quota" }, { "retry-after": "3600" })]);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.status, 429);
      assert.equal(e.message, "LinkedIn rate-limited the request. Retry later and reduce duplicate calls. quota. Retry after about 1 hour.");
      return true;
    });
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  test("a LinkedIn message that already ends with a period does not produce '..'", async () => {
    const { client } = setup([
      () => jsonResponse(429, { message: "Daily limit is reached." }, { "retry-after": "7200" }),
    ]);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(
        e.message,
        "LinkedIn rate-limited the request. Retry later and reduce duplicate calls. Daily limit is reached. Retry after about 2 hours.",
      );
      return true;
    });
  });

  test("a Retry-After of exactly 8 seconds (the wait cap) is slept; 9 seconds fails fast with the wait in the message", async () => {
    const eight = setup([() => jsonResponse(429, {}, { "retry-after": "8" }), () => jsonResponse(200, page([{ a: 1 }]))]);
    assert.equal((await snapshot(eight.client)).snapshotData.length, 1);
    assert.deepEqual(eight.sleeps, [8000]);

    const nine = setup([() => jsonResponse(429, { message: "slow down" }, { "retry-after": "9" })]);
    await assert.rejects(snapshot(nine.client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.message, "LinkedIn rate-limited the request. Retry later and reduce duplicate calls. slow down. Retry after about 9 seconds.");
      return true;
    });
    assert.equal(nine.fetch.calls.length, 1);
    assert.deepEqual(nine.sleeps, []);
  });

  test("a 501 is retried like any other 5xx", async () => {
    const { fetch, sleeps, client } = setup([() => jsonResponse(501, { message: "not implemented" }), () => jsonResponse(200, page([{ a: 1 }]))]);
    assert.equal((await snapshot(client)).snapshotData.length, 1);
    assert.equal(fetch.calls.length, 2);
    assert.equal(sleeps.length, 1);
  });

  test("network failures are retried, then reported as status 0", async () => {
    const boom = () => Promise.reject(new TypeError("fetch failed"));
    const { fetch, client } = setup([boom], 2);
    await assert.rejects(snapshot(client), (e: unknown) => e instanceof LinkedInApiError && e.status === 0 && /fetch failed/.test(e.message));
    assert.equal(fetch.calls.length, 3);
  });
});

describe("response handling", () => {
  test("a LinkedIn error that echoes the token never leaks it", async () => {
    const { client } = setup([() => jsonResponse(401, { message: `Invalid access token ${TOKEN} (Bearer ${TOKEN})` })], 0);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.ok(!e.message.includes(TOKEN), e.message);
      return true;
    });
  });

  test("a network error that echoes the token never leaks it", async () => {
    const { client } = setup([() => Promise.reject(new TypeError(`bad header value: Bearer ${TOKEN}`))], 0);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.ok(!e.message.includes(TOKEN), e.message);
      return true;
    });
  });

  test("a token with a newline is refused before it reaches fetch and is not echoed", async () => {
    // A lenient fetch (no header validation), so only the client's own guard can stop the request.
    let sent = 0;
    const client = new LinkedInClient({ fetchImpl: (async () => (sent++, jsonResponse(200, page([])))) as typeof fetch, maxRetries: 0 });
    const bad = `abc-secret\ndef-secret`;
    await assert.rejects(client.getSnapshotDomain({ accessToken: bad, domain: "POSITIONS" }), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.ok(!e.message.includes("abc-secret") && !e.message.includes("def-secret"), e.message);
      return true;
    });
    assert.equal(sent, 0);
  });

  test("an HTML error page does not end up in the message: the status text stands in for it", async () => {
    const html = `<html><body>${"Bad gateway ".repeat(500)}</body></html>`;
    const { client } = setup([() => new Response(html, { status: 502, statusText: "Bad Gateway" })], 0);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.status, 502);
      assert.equal(e.message, "LinkedIn returned a server-side failure or timeout. Retry later. Bad Gateway");
      return true;
    });
  });

  test("an error response with an empty body falls back to the HTTP status in the message", async () => {
    const { client } = setup([() => new Response("", { status: 500 })], 0);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.status, 500);
      assert.equal(e.message, "LinkedIn returned a server-side failure or timeout. Retry later. HTTP 500");
      return true;
    });
  });

  test("a 200 whose body is not JSON is an error, not an empty section", async () => {
    for (const body of ["<html>maintenance</html>", "[1,2]", "null", "42"]) {
      const { client } = setup([() => new Response(body, { status: 200 })], 0);
      await assert.rejects(snapshot(client), (e: unknown) => e instanceof LinkedInApiError && /unexpected response/i.test(e.message), body);
    }
  });

  test("a very long error message from LinkedIn is cut to exactly 300 characters", async () => {
    const { client } = setup([() => jsonResponse(400, { message: "x".repeat(10_000) })], 0);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      const prefix = "LinkedIn rejected the request as invalid. Check the requested section, timestamp, count, or query parameters. ";
      assert.equal(e.message, prefix + "x".repeat(300));
      assert.ok(e.message.endsWith(" " + "x".repeat(300)));
      assert.ok(!e.message.endsWith("x".repeat(301)));
      return true;
    });
  });

  test("a network error text is cut to exactly 300 characters too", async () => {
    const { client } = setup([() => Promise.reject(new TypeError("y".repeat(5000)))], 0);
    await assert.rejects(snapshot(client), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.message, "LinkedIn request failed: " + "y".repeat(300));
      return true;
    });
  });

  test("elements that are missing, null or an object yield no rows without throwing", async () => {
    for (const body of [{}, { elements: null }, { elements: { snapshotData: [{ a: 1 }] } }, { elements: [{ snapshotData: "nope" }, null, 5] }]) {
      const { client } = setup([() => jsonResponse(200, body)], 0);
      assert.deepEqual((await snapshot(client)).snapshotData, [], JSON.stringify(body));
    }
  });
});

describe("next links", () => {
  test("only same-host https links are followed; the token never goes elsewhere", async () => {
    for (const href of ["http://api.linkedin.com/rest/memberSnapshotData?start=1", "https://api.linkedin.com.evil.test/x", "//evil.test/x", "https://evil.test/x", "https://user:pw@evil.test/x", "ftp://api.linkedin.com/x", "https://api.linkedin.com@evil.test/x", "https://api.linkedin.com./x", "https://api.linkedin.com:8443/x", "/\\evil.test/x"]) {
      const { fetch, client } = setup([() => jsonResponse(200, page([{ a: 1 }], href))], 0);
      const result = await snapshot(client);
      assert.equal(fetch.calls.length, 1, href);
      assert.equal(result.truncated, false, href);
      assert.equal(new URL(fetch.calls[0]!.url).host, "api.linkedin.com", href);
    }
  });

  test("a redirect is never followed: fetch is told to fail on it, and the token goes to one host only", async () => {
    const calls: { url: string; redirect: RequestRedirect | undefined; authorization: string | null }[] = [];
    // Behaves like fetch: redirect "error" rejects on a 3xx, "follow" (the default) re-requests the location.
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect, authorization: new Headers(init?.headers).get("authorization") });
      if (url.startsWith("https://api.linkedin.com/")) {
        if (init?.redirect === "error") {
          throw new TypeError("fetch failed");
        }
        return await impl("https://evil.test/steal", init);
      }
      return jsonResponse(200, { elements: [] });
    }) as typeof fetch;
    const client = new LinkedInClient({ fetchImpl: impl, maxRetries: 0 });
    await assert.rejects(client.getAuthorizationStatus({ accessToken: TOKEN }), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.status, 0);
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.redirect, "error");
    assert.equal(new URL(calls[0]!.url).host, "api.linkedin.com");
  });

  test("a relative next link is followed on the same host", async () => {
    const { fetch, client } = setup([
      () => jsonResponse(200, page([{ a: 1 }], "/rest/memberSnapshotData?q=criteria&domain=POSITIONS&start=1")),
      () => jsonResponse(200, page([{ a: 2 }])),
    ]);
    assert.equal((await snapshot(client)).snapshotData.length, 2);
    assert.equal(new URL(fetch.calls[1]!.url).host, "api.linkedin.com");
  });

  test("a next link pointing back at the same URL stops at the page cap and flags truncation", async () => {
    const self = "https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=POSITIONS";
    const { fetch, client } = setup([() => jsonResponse(200, page([{ a: 1 }], self))]);
    const result = await snapshot(client);
    assert.equal(fetch.calls.length, 50);
    assert.equal(result.truncated, true);
  });
});

describe("request timeout", () => {
  /** A fetch that never answers on its own: it rejects only when the request's abort signal fires. A 1 s guard keeps a missing signal from hanging the suite. */
  const hangingFetch = () => {
    const state = { calls: 0, signals: 0 };
    const impl = ((_url: unknown, init?: RequestInit) => {
      state.calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          state.signals += 1;
          signal.addEventListener("abort", () => reject(signal.reason));
        }
        setTimeout(() => reject(new Error("guard: the request was never aborted")), 1000).unref();
      });
    }) as typeof fetch;
    return { impl, state };
  };

  test("a request that outlives requestTimeoutMs is aborted and fails with status 0 and the timeout reason", async () => {
    const { impl, state } = hangingFetch();
    const client = new LinkedInClient({ fetchImpl: impl, requestTimeoutMs: 20, maxRetries: 0 });
    await assert.rejects(client.getAuthorizationStatus({ accessToken: TOKEN }), (e: unknown) => {
      assert.ok(e instanceof LinkedInApiError);
      assert.equal(e.status, 0);
      assert.equal(e.message, "LinkedIn request failed: The operation was aborted due to timeout");
      return true;
    });
    assert.deepEqual(state, { calls: 1, signals: 1 });
  });

  test("a timeout is retried like a network failure: every attempt gets its own signal and a sleep in between", async () => {
    const { impl, state } = hangingFetch();
    const sleeps: number[] = [];
    const client = new LinkedInClient({ fetchImpl: impl, requestTimeoutMs: 20, maxRetries: 2, sleep: async (ms) => void sleeps.push(ms) });
    await assert.rejects(client.getAuthorizationStatus({ accessToken: TOKEN }), (e: unknown) => e instanceof LinkedInApiError && e.status === 0);
    assert.deepEqual(state, { calls: 3, signals: 3 });
    assert.equal(sleeps.length, 2);
  });
});

describe("page cap", () => {
  test("exactly maxPages pages with no next link is complete, not truncated", async () => {
    const next = "https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=POSITIONS&start=1";
    const { fetch, client } = setup([() => jsonResponse(200, page([{ a: 1 }], next)), () => jsonResponse(200, page([{ a: 2 }]))]);
    const result = await client.getSnapshotDomain({ accessToken: TOKEN, domain: "POSITIONS", maxPages: 2 });
    assert.equal(fetch.calls.length, 2);
    assert.equal(result.pageCount, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.snapshotData.length, 2);
  });

  test("one page fewer than the data needs is truncated", async () => {
    const next = "https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=POSITIONS&start=1";
    const { fetch, client } = setup([() => jsonResponse(200, page([{ a: 1 }], next)), () => jsonResponse(200, page([{ a: 2 }]))]);
    const result = await client.getSnapshotDomain({ accessToken: TOKEN, domain: "POSITIONS", maxPages: 1 });
    assert.equal(fetch.calls.length, 1);
    assert.equal(result.truncated, true);
  });
});
