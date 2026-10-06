import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { Cache } from "../src/cache.js";
import { LinkedInClient } from "../src/linkedin/client.js";
import { createUnlinkedServer } from "../src/mcp/server.js";
import { createService } from "../src/service.js";
import { commentEvent, likeEvent, peopleEvent, T } from "./helpers/events.js";
import { jsonResponse } from "./helpers/fake-fetch.js";
import { linkedinFake, type LinkedInFakeOptions } from "./helpers/linkedin-fake.js";

const TOKEN = "synthetic-secret-token-value";

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any>; isError?: boolean };

const reactions = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    Date: `2026-09-${String(10 + (i % 15)).padStart(2, "0")} 10:00:${String(i % 60).padStart(2, "0")}`,
    Type: "LIKE",
    Link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + i}`,
  }));

/** A connected SDK client. It lists the tools first, like real clients, so output schemas are enforced. */
async function connect(options: LinkedInFakeOptions | { fetchImpl: typeof fetch } = {}) {
  const fake = linkedinFake("fetchImpl" in options ? {} : options);
  const fetchImpl = "fetchImpl" in options ? options.fetchImpl : fake.impl;
  let clock = T(25);
  const service = createService({
    client: new LinkedInClient({ fetchImpl, maxRetries: 0 }),
    cache: new Cache({ token: TOKEN, now: () => clock }),
    accessToken: TOKEN,
    now: () => clock,
  });
  const server = createUnlinkedServer({ service });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
  return { fake, client, call, advance: (ms: number) => void (clock += ms), close: () => client.close() };
}

const errorText = (result: Result) => result.content.map((c) => c.text).join("\n");

const RESUME_IDS = [
  "intro", "experience", "education", "skills", "certifications", "projects", "languages", "volunteering", "honors",
  "courses", "publications", "patents", "test-scores", "organizations", "causes", "recommendations", "services",
];

describe("the published input schemas", () => {
  test("the profile sections enum is exactly the 17 resume sections: unbounded and blocked ids are not options", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any> }).properties;
    assert.deepEqual(props("linkedin_get_profile").sections.items.enum, RESUME_IDS);
    assert.deepEqual(props("linkedin_get_section").section.enum, [
      ...RESUME_IDS,
      "endorsements-given", "posts", "comments", "reactions", "reposts", "articles", "connections", "invitations",
      "followed-companies", "followed-people", "groups", "saved-jobs", "job-applications", "job-preferences", "job-postings", "learning",
    ]);
    await close();
  });
});

describe("invalid input never reaches LinkedIn and is an isError result, never a thrown protocol error", () => {
  // Rejected by the published input schema (zod through the SDK): "MCP error -32602". Only Unlinked's own bounds and
  // enums are listed: plain type checks (a number where text belongs and so on) are zod's job, not ours.
  const schemaRejects: Array<[string, Record<string, unknown>]> = [
    ["linkedin_get_section", { section: "reactions", limit: 0 }],
    ["linkedin_get_section", { section: "reactions", limit: 201 }],
    ["linkedin_get_section", { section: "reactions", limit: 1.5 }],
    ["linkedin_get_section", {}],
    ["linkedin_get_section", { section: "inbox" }],
    ["linkedin_get_section", { section: "POSITIONS" }],
    ["linkedin_get_profile", { sections: ["reactions"] }],
    ["linkedin_get_profile", { sections: ["inbox"] }],
    ["linkedin_get_recent_activity", { limit: 0 }],
  ];

  // Passes the schema, then rejected by Unlinked's own validation: "Error: <specific message>".
  const serviceRejects: Array<[string, Record<string, unknown>, RegExp]> = [
    ["linkedin_get_section", { section: "reactions", cursor: "garbage" }, /^Error: Invalid cursor\. Use the nextCursor value from the previous page\.$/],
    ["linkedin_get_recent_activity", { cursor: "garbage" }, /^Error: Invalid cursor\. Use the nextCursor value from the previous page\.$/],
    ["linkedin_get_recent_activity", { since: "junk" }, /^Error: Invalid since value "junk"\. Use a duration like 7d or 12h, an ISO date, or epoch milliseconds\.$/],
    ["linkedin_get_recent_activity", { since: "2026-02-30" }, /^Error: Invalid since value "2026-02-30"\. Use a duration/],
    ["linkedin_get_recent_activity", { since: "99999999999999999999" }, /^Error: Invalid since value "99999999999999999999"\. Use a duration/],
  ];

  test("schema violations are MCP -32602 errors", async () => {
    const { call, fake, close } = await connect({ snapshots: { ALL_LIKES: reactions(5) } });
    for (const [tool, args] of schemaRejects) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const result = await call(tool, args).catch((error: unknown) => assert.fail(`${label} threw: ${String(error)}`));
      assert.equal(result.isError, true, label);
      assert.equal(result.structuredContent, undefined, label);
      assert.match(result.content[0]!.text, /^MCP error -32602/, label);
    }
    assert.equal(fake.urls.length, 0);
    await close();
  });

  test("values the schema allows but the service refuses are plain Error results with a specific message", async () => {
    const { call, fake, close } = await connect({ snapshots: { ALL_LIKES: reactions(5) } });
    for (const [tool, args, message] of serviceRejects) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const result = await call(tool, args).catch((error: unknown) => assert.fail(`${label} threw: ${String(error)}`));
      assert.equal(result.isError, true, label);
      assert.equal(result.structuredContent, undefined, label);
      assert.match(result.content[0]!.text, message, label);
    }
    assert.equal(fake.urls.length, 0);
    await close();
  });
});

describe("cursor errors", () => {
  test("a stale cursor, a foreign cursor and a garbage cursor are isError results", async () => {
    const { call, advance, close } = await connect({ snapshots: { ALL_LIKES: reactions(10), ALL_COMMENTS: [{ Date: "2026-09-01 10:00:00", Link: "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A1", Message: "a" }, { Date: "2026-09-02 10:00:00", Link: "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A2", Message: "b" }] } });
    const page = await call("linkedin_get_section", { section: "reactions", limit: 2 });
    const cursor = page.structuredContent!.nextCursor as string;
    const foreign = await call("linkedin_get_section", { section: "comments", limit: 1, cursor });
    assert.equal(foreign.isError, true);
    assert.match(errorText(foreign), /^Error: This cursor came from a different request \("reactions"\), not "comments"\./);
    advance(5);
    await call("linkedin_get_section", { section: "reactions", refresh: true });
    const stale = await call("linkedin_get_section", { section: "reactions", limit: 2, cursor });
    assert.equal(stale.isError, true);
    assert.equal(errorText(stale), "Error: The data changed, restart from first page (the cursor was issued before a refresh).");
    const garbage = await call("linkedin_get_section", { section: "reactions", cursor: "garbage" });
    assert.equal(garbage.isError, true);
    assert.match(errorText(garbage), /^Error: Invalid cursor\./);
    await close();
  });
});

describe("refresh", () => {
  test("refresh: true refetches; without it the cache is used", async () => {
    const { call, fake, close } = await connect({ snapshots: { SKILLS: [{ Name: "Rust" }] } });
    await call("linkedin_get_section", { section: "skills" });
    const first = fake.urls.length;
    await call("linkedin_get_section", { section: "skills" });
    assert.equal(fake.urls.length, first);
    await call("linkedin_get_section", { section: "skills", refresh: true });
    assert.equal(fake.urls.length, first * 2);
    await close();
  });
});

describe("concurrency", () => {
  test("five identical calls share one snapshot request and one changelog request", async () => {
    const { call, fake, close } = await connect({ snapshots: { ALL_LIKES: reactions(5) } });
    const results = await Promise.all(Array.from({ length: 5 }, () => call("linkedin_get_section", { section: "reactions" })));
    assert.ok(results.every((r) => r.isError === undefined && r.structuredContent?.total === 5));
    assert.deepEqual(fake.domains(), ["ALL_LIKES"]);
    assert.equal(fake.changelogRequests(), 1);
    await close();
  });

  test("different sections in parallel each fetch once, and every answer matches its own request", async () => {
    const { call, fake, close } = await connect({
      snapshots: { ALL_LIKES: reactions(3), SKILLS: [{ Name: "Rust" }], LANGUAGES: [{ Name: "Danish" }, { Name: "English" }] },
    });
    const [likes, skills, languages, profile] = await Promise.all([
      call("linkedin_get_section", { section: "reactions" }),
      call("linkedin_get_section", { section: "skills" }),
      call("linkedin_get_section", { section: "languages" }),
      call("linkedin_get_profile", { sections: ["skills", "languages"] }),
    ]);
    assert.deepEqual([likes.structuredContent?.section, likes.structuredContent?.total], ["reactions", 3]);
    assert.deepEqual([skills.structuredContent?.section, skills.structuredContent?.total], ["skills", 1]);
    assert.deepEqual([languages.structuredContent?.section, languages.structuredContent?.total], ["languages", 2]);
    assert.equal(profile.structuredContent?.languages.length, 2);
    assert.deepEqual([...fake.domains()].sort(), ["ALL_LIKES", "LANGUAGES", "SKILLS"]);
    assert.equal(fake.changelogRequests(), 1);
    await close();
  });

  test("with the changelog down, each call reports its own outcome without interleaving", async () => {
    const { call, close } = await connect({ snapshots: { ALL_LIKES: reactions(3), SKILLS: [{ Name: "Rust" }] }, changelogStatus: 403 });
    const [profile, activity, likes] = await Promise.all([
      call("linkedin_get_profile", { sections: ["skills"] }),
      call("linkedin_get_recent_activity"),
      call("linkedin_get_section", { section: "reactions" }),
    ]);
    assert.equal(profile.isError, undefined);
    assert.match(profile.structuredContent!.freshness.recentChangesError, /denied access/);
    assert.equal(activity.isError, true);
    assert.match(errorText(activity), /denied access/);
    assert.equal(likes.isError, undefined);
    assert.equal(likes.structuredContent?.total, 3);
    await close();
  });
});

describe("a failing upstream does not poison later calls", () => {
  for (const [status, headers] of [[401, {}], [429, { "retry-after": "30" }], [500, {}], [503, {}]] as const) {
    test(`${status} once, then success`, async () => {
      const real = linkedinFake({ snapshots: { SKILLS: [{ Name: "Rust" }] } });
      let failNext = true;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (failNext && String(input).includes("memberSnapshotData")) {
          failNext = false;
          return jsonResponse(status, { message: `synthetic ${status}` }, headers);
        }
        return real.impl(input, init);
      }) as typeof fetch;
      const { call, close } = await connect({ fetchImpl });
      const failed = await call("linkedin_get_section", { section: "skills" });
      assert.equal(failed.isError, true);
      assert.match(errorText(failed), new RegExp(String(status)));
      assert.doesNotMatch(errorText(failed), new RegExp(TOKEN));
      const retried = await call("linkedin_get_section", { section: "skills" });
      assert.equal(retried.isError, undefined);
      assert.equal(retried.structuredContent?.total, 1);
      await close();
    });
  }

  test("a failed changelog is not cached either: the next profile call recovers", async () => {
    const real = linkedinFake({ snapshots: { SKILLS: [{ Name: "Rust" }] }, events: [peopleEvent({ headline: "Fresh" }, T(24))] });
    let down = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
      down && String(input).includes("memberChangeLogs") ? jsonResponse(500, { message: "oops" }) : real.impl(input, init)) as typeof fetch;
    const { call, close } = await connect({ fetchImpl });
    const first = await call("linkedin_get_profile", { sections: ["skills", "intro"] });
    assert.equal(
      first.structuredContent?.freshness.recentChangesError,
      "LinkedIn returned a server-side failure or timeout. Retry later. oops",
    );
    down = false;
    const second = await call("linkedin_get_profile", { sections: ["skills", "intro"] });
    assert.equal(second.structuredContent?.freshness.recentChangesError, undefined);
    assert.equal(second.structuredContent?.intro.headline, "Fresh");
    await close();
  });
});

describe("structuredContent validates against the output schema for realistic data", () => {
  // The SDK client validates every successful result against the tool's outputSchema and throws when it does not match.
  test("everything empty (all sections 404, no events)", async () => {
    const { call, close } = await connect({});
    const profile = await call("linkedin_get_profile", { all: true });
    assert.equal(profile.isError, undefined);
    assert.deepEqual(profile.structuredContent!.freshness.empty, RESUME_IDS);
    const section = await call("linkedin_get_section", { section: "honors" });
    assert.deepEqual([section.structuredContent?.items, section.structuredContent?.total], [[], 0]);
    const activity = await call("linkedin_get_recent_activity");
    assert.deepEqual([activity.structuredContent?.items, activity.structuredContent?.total], [[], 0]);
    assert.equal((await call("linkedin_check_access")).structuredContent?.connected, false);
    await close();
  });

  test("the last page has no nextCursor and a middle page has one", async () => {
    const { call, close } = await connect({ snapshots: { ALL_LIKES: reactions(5) } });
    const first = await call("linkedin_get_section", { section: "reactions", limit: 3 });
    assert.equal(typeof first.structuredContent?.nextCursor, "string");
    const last = await call("linkedin_get_section", { section: "reactions", limit: 3, cursor: first.structuredContent?.nextCursor });
    assert.equal("nextCursor" in last.structuredContent!, false);
    await close();
  });

  test("unicode, very long text, nested values and merged events", async () => {
    const long = "Ünïcödé 🚀 ".repeat(30_000);
    const { call, close } = await connect({
      snapshots: {
        PROFILE: [{ "First Name": "Zoë", Headline: "日本語 🚀", Summary: long }],
        POSITIONS: [{ "Company Name": "Æ/Ø", Title: "Eng", Description: long, nested: { deep: [1, { x: null }] } }],
        ALL_COMMENTS: [{ Date: "2026-09-01 10:00:00", Link: "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A1", Message: long }],
      },
      events: [likeEvent("urn:li:activity:111111111111", { capturedAt: T(24) }), commentEvent("urn:li:activity:222222222222", "7", "😀", { capturedAt: T(24) }), peopleEvent({ headline: "Nový 🚀" }, T(24))],
    });
    const profile = await call("linkedin_get_profile");
    assert.equal(profile.structuredContent?.intro.about, long);
    assert.equal(profile.structuredContent?.intro.headline, "Nový 🚀");
    assert.deepEqual(profile.structuredContent?.experience[0].nested, { deep: [1, { x: null }] });
    const comments = await call("linkedin_get_section", { section: "comments" });
    assert.equal(comments.structuredContent?.total, 2);
    const activity = await call("linkedin_get_recent_activity", { since: "2020-01-01" });
    assert.equal(activity.structuredContent?.total, 3);
    await close();
  });

  test("check_access copes with odd authorization records", async () => {
    const { call, close } = await connect({ authorizations: [null, 5, "x", { regulatedAt: "soon" }, { regulatedAt: T(10) }] });
    const result = await call("linkedin_check_access");
    assert.deepEqual(result.structuredContent, { connected: true, trackingChangesSince: new Date(T(10)).toISOString() });
    await close();
  });

  test("check_access with a 401 is an isError result", async () => {
    const { call, close } = await connect({ fetchImpl: (async () => jsonResponse(401, { message: "expired" })) as typeof fetch });
    const result = await call("linkedin_check_access");
    assert.equal(result.isError, true);
    assert.match(errorText(result), /401/);
    await close();
  });
});
