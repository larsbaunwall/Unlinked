import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cache } from "../src/cache.js";
import { LinkedInClient, LinkedInApiError } from "../src/linkedin/client.js";
import { UsageError, createService, parseSince } from "../src/service.js";
import { commentEvent, event, likeEvent, peopleEvent, positionEvent, postEvent, T } from "./helpers/events.js";
import { linkedinFake, type LinkedInFakeOptions } from "./helpers/linkedin-fake.js";
import { tempDir } from "./helpers/temp-dir.js";

const TOKEN = "synthetic-secret-token-value";
const NOW = T(25, 12);
const DAY = 86_400_000;

function clock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function setup(options: LinkedInFakeOptions = {}, { cacheDir, ttlMs }: { cacheDir?: string; ttlMs?: number } = {}) {
  const fake = linkedinFake(options);
  const c = clock();
  const client = new LinkedInClient({ fetchImpl: fake.impl, maxRetries: 0 });
  const cache = new Cache({ token: TOKEN, now: c.now, ...(cacheDir ? { cacheDir } : {}), ...(ttlMs === undefined ? {} : { ttlMs }) });
  const service = createService({ client, cache, accessToken: TOKEN, now: c.now });
  return { fake, clock: c, service, cache };
}

const reactionRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    Date: `2026-09-${String(20 - Math.floor(i / 20)).padStart(2, "0")} 10:${String(59 - (i % 60)).padStart(2, "0")}:00`,
    Type: "LIKE",
    Link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + i}`,
  }));

/** Every résumé section a profile can embed, as JSON keys, in order. Written out by hand on purpose. */
const RESUME_KEYS = [
  "intro", "experience", "education", "skills", "certifications", "projects", "languages", "volunteering", "honors",
  "courses", "publications", "patents", "testScores", "organizations", "causes", "recommendations", "services",
];
const RESUME_DOMAINS = [
  "CAUSES_YOU_CARE_ABOUT", "CERTIFICATIONS", "COURSES", "EDUCATION", "HONORS", "LANGUAGES", "MARKETPLACE_PROVIDERS", "ORGANIZATIONS",
  "PATENTS", "POSITIONS", "PROFILE", "PROJECTS", "PUBLICATIONS", "RECOMMENDATIONS", "SKILLS", "TEST_SCORES", "VOLUNTEERING_EXPERIENCES",
];
const UNBOUNDED_IDS = [
  "endorsements-given", "posts", "comments", "reactions", "reposts", "articles", "connections", "invitations", "followed-companies",
  "followed-people", "groups", "saved-jobs", "job-applications", "job-preferences", "job-postings", "learning",
];

const baseSnapshots = {
  PROFILE: [{ "First Name": "Ada", "Last Name": "Synthetic", Headline: "Builder", Summary: "About me", "Birth Date": "Jan 1", Address: "1 Fake St", "Zip Code": "00000", "Geo Location": "Copenhagen" }],
  POSITIONS: [{ "Company Name": "Acme", Title: "Engineer", Description: "Built things", "Started On": "Mar 2014" }],
  SKILLS: [{ Name: "TypeScript" }],
};

describe("getProfile", () => {
  test("embeds the default bounded sections and fetches nothing else but the changelog", async () => {
    const { fake, service } = setup({ snapshots: baseSnapshots });
    const profile = await service.getProfile();
    assert.deepEqual(
      Object.keys(profile),
      ["intro", "experience", "education", "skills", "certifications", "projects", "related", "freshness"],
    );
    assert.deepEqual([...fake.domains()].sort(), ["CERTIFICATIONS", "EDUCATION", "POSITIONS", "PROFILE", "PROJECTS", "SKILLS"]);
    assert.equal(fake.changelogRequests(), 1);
    assert.deepEqual(profile.experience, [{ companyName: "Acme", title: "Engineer", description: "Built things", startedOn: "Mar 2014" }]);
  });

  test("returns related links for every unbounded section with zero fetches for them", async () => {
    const { fake, service } = setup({ snapshots: baseSnapshots });
    const profile = await service.getProfile();
    const related = profile.related as Array<{ section: string; label: string }>;
    assert.deepEqual(related.map((r) => r.section), UNBOUNDED_IDS);
    assert.deepEqual(related.find((r) => r.section === "reactions"), { section: "reactions", label: "Activity > Reactions" });
    const fetched = new Set(fake.domains());
    for (const domain of ["ALL_LIKES", "ALL_COMMENTS", "MEMBER_SHARE_INFO", "CONNECTIONS", "INVITATIONS", "LEARNING", "JOB_APPLICATIONS"]) {
      assert.equal(fetched.has(domain), false, domain);
    }
  });

  test("sections picks résumé sections; all embeds every résumé section", async () => {
    const one = setup({ snapshots: { LANGUAGES: [{ Name: "English", Proficiency: "NATIVE" }] } });
    const profile = await one.service.getProfile({ sections: ["languages"] });
    assert.deepEqual(Object.keys(profile), ["languages", "related", "freshness"]);
    assert.deepEqual(one.fake.domains(), ["LANGUAGES"]);

    const all = setup({ snapshots: baseSnapshots });
    const full = await all.service.getProfile({ all: true });
    assert.deepEqual(Object.keys(full), [...RESUME_KEYS, "related", "freshness"]);
    assert.deepEqual([...all.fake.domains()].sort(), RESUME_DOMAINS);
  });

  test("rejects unknown, blocked and unbounded sections without fetching", async () => {
    const { fake, service } = setup({ snapshots: baseSnapshots });
    await assert.rejects(service.getProfile({ sections: ["nonsense"] }), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /^Unknown section "nonsense"\. Available sections: intro, experience, education, /);
      return true;
    });
    await assert.rejects(
      service.getProfile({ sections: ["inbox"] }),
      new UsageError('The "inbox" section is not available: it holds sensitive data that Unlinked never reads.'),
    );
    await assert.rejects(
      service.getProfile({ sections: ["reactions"] }),
      new UsageError('"reactions" can be large, so it is not part of the profile. Request it on its own as a section.'),
    );
    assert.equal(fake.urls.length, 0);
  });

  test("merges recent headline edits into the intro, renames summary and redacts private fields", async () => {
    const { service } = setup({
      snapshots: baseSnapshots,
      events: [peopleEvent({ headline: { localized: { en_US: "Staff Builder" } } }, T(24))],
    });
    const profile = await service.getProfile();
    assert.deepEqual(profile.intro, { firstName: "Ada", lastName: "Synthetic", headline: "Staff Builder", about: "About me", geoLocation: "Copenhagen" });
    assert.equal((profile.freshness as { recentChangesMerged: number }).recentChangesMerged, 1);
  });

  test("intro keys named like inherited Object properties are kept as they are", async () => {
    const { service } = setup({
      snapshots: { ...baseSnapshots, PROFILE: [{ "First Name": "Ada", constructor: "c-value", toString: "t-value", Summary: "About me" }] },
    });
    const intro = await service.getSection({ section: "intro" });
    assert.deepEqual(intro.items[0], { firstName: "Ada", constructor: "c-value", toString: "t-value", about: "About me" });
  });

  test("freshness: empty sections, pending edits, and asOf of the oldest cached input", async () => {
    const { service, clock: c } = setup({
      snapshots: baseSnapshots,
      events: [positionEvent({ description: "A brand new description" }, T(24))],
    });
    await service.getSection({ section: "skills" });
    c.advance(3_600_000);
    const profile = await service.getProfile();
    const freshness = profile.freshness as Record<string, unknown>;
    assert.equal(freshness.asOf, new Date(NOW).toISOString());
    assert.deepEqual(freshness.pendingEdits, ["experience"]);
    assert.deepEqual(freshness.empty, ["education", "certifications", "projects"]);
    assert.deepEqual(profile.certifications, []);
    assert.equal(freshness.recentChangesMerged, 0);
    assert.equal("incomplete" in freshness, false);
    assert.equal("recentChangesError" in freshness, false);
  });

  test("still returns the snapshot when the changelog fails, and says so in freshness", async () => {
    const { service } = setup({ snapshots: baseSnapshots, changelogStatus: 403 });
    const profile = await service.getProfile();
    assert.equal((profile.skills as unknown[]).length, 1);
    const freshness = profile.freshness as Record<string, unknown>;
    assert.equal(freshness.recentChangesMerged, 0);
    assert.match(String(freshness.recentChangesError), /denied access/);
    assert.doesNotMatch(JSON.stringify(profile), new RegExp(TOKEN));
  });

  test("a truncated changelog marks the result incomplete", async () => {
    const { service } = setup({ snapshots: baseSnapshots, changelogEndless: true });
    const profile = await service.getProfile();
    assert.equal((profile.freshness as Record<string, unknown>).incomplete, true);
  });

  test("the second call is served from the cache; refresh refetches", async () => {
    const { fake, service } = setup({ snapshots: baseSnapshots });
    await service.getProfile();
    const first = fake.urls.length;
    await service.getProfile();
    assert.equal(fake.urls.length, first);
    await service.getProfile({ refresh: true });
    assert.equal(fake.urls.length, first * 2);
  });
});

describe("getSection", () => {
  const reactions = reactionRows(120);

  test("an edited position text that the snapshot lacks is reported as a pending experience edit", async () => {
    const { service } = setup({ snapshots: baseSnapshots, events: [positionEvent({ description: "A brand new description" }, T(24))] });
    const page = await service.getSection({ section: "experience" });
    assert.deepEqual(page.freshness.pendingEdits, ["experience"]);
    assert.equal(page.freshness.recentChangesMerged, 0);
    assert.deepEqual(page.items, [{ companyName: "Acme", title: "Engineer", description: "Built things", startedOn: "Mar 2014" }]);
  });

  test("an edit whose text the snapshot already shows is not pending", async () => {
    const { service } = setup({ snapshots: baseSnapshots, events: [positionEvent({ description: "Built things" }, T(24))] });
    assert.deepEqual((await service.getSection({ section: "experience" })).freshness.pendingEdits, []);
  });

  test("pages newest-first with merged changelog reactions; cursor absent on the last page", async () => {
    const missing = "urn:li:comment:(activity:8000000000001,8000000000002)";
    const { service } = setup({
      snapshots: { ALL_LIKES: reactions },
      events: [likeEvent(missing, { capturedAt: T(24, 9), reactionType: "PRAISE" })],
    });
    const page1 = await service.getSection({ section: "reactions", limit: 50 });
    assert.equal(page1.section, "reactions");
    assert.equal(page1.total, 121);
    assert.equal(page1.items.length, 50);
    assert.deepEqual(Object.keys(page1.items[0] as object), ["date", "type", "link"]);
    assert.equal((page1.items[0] as { type: string }).type, "PRAISE");
    assert.equal(page1.freshness.recentChangesMerged, 1);
    const page2 = await service.getSection({ section: "reactions", limit: 50, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 50);
    assert.ok(page2.nextCursor);
    const page3 = await service.getSection({ section: "reactions", limit: 50, cursor: page2.nextCursor });
    assert.equal(page3.items.length, 21);
    assert.equal(page3.nextCursor, undefined);
    const all = [...page1.items, ...page2.items, ...page3.items] as Array<{ link: string; type: string }>;
    assert.equal(new Set(all.map((i) => i.link)).size, 121);
    assert.ok(all.some((i) => i.type === "PRAISE" && i.link.includes("commentUrn")));
  });

  test("merges comments and posts too", async () => {
    const { service } = setup({
      snapshots: { ALL_COMMENTS: [{ Date: "2026-09-01 10:00:00", Link: "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A1", Message: "old" }], MEMBER_SHARE_INFO: [] },
      events: [
        commentEvent("urn:li:activity:2222222222222", "9", "fresh comment", { capturedAt: T(24) }),
        postEvent("urn:li:ugcPost:333", "fresh post", { capturedAt: T(23) }),
      ],
    });
    const comments = await service.getSection({ section: "comments" });
    assert.equal(comments.total, 2);
    assert.equal((comments.items[0] as { message: string }).message, "fresh comment");
    const posts = await service.getSection({ section: "posts" });
    assert.equal(posts.total, 1);
    assert.equal((posts.items[0] as { shareCommentary: string }).shareCommentary, "fresh post");
  });

  test("a changelog failure still returns the snapshot items", async () => {
    const { service } = setup({ snapshots: { ALL_LIKES: reactions }, changelogStatus: 403 });
    const page = await service.getSection({ section: "reactions", limit: 10 });
    assert.equal(page.total, 120);
    assert.match(String(page.freshness.recentChangesError), /denied access/);
  });

  test("a cursor from before a refresh is rejected", async () => {
    const { service, clock: c } = setup({ snapshots: { ALL_LIKES: reactions } });
    const page1 = await service.getSection({ section: "reactions", limit: 50 });
    c.advance(1000);
    await service.getSection({ section: "reactions", limit: 50, refresh: true });
    await assert.rejects(
      service.getSection({ section: "reactions", limit: 50, cursor: page1.nextCursor }),
      /data changed, restart from first page/,
    );
  });

  test("a garbage cursor is rejected before any fetch", async () => {
    const { service, fake } = setup({ snapshots: { ALL_LIKES: reactions } });
    await assert.rejects(service.getSection({ section: "reactions", cursor: "garbage" }), UsageError);
    assert.equal(fake.urls.length, 0);
  });

  test("the intro is a single item; rows are not merged for plain sections", async () => {
    const { service } = setup({ snapshots: baseSnapshots });
    const intro = await service.getSection({ section: "intro" });
    assert.equal(intro.total, 1);
    assert.equal((intro.items[0] as { about: string }).about, "About me");
    const skills = await service.getSection({ section: "skills" });
    assert.deepEqual(skills.items, [{ name: "TypeScript" }]);
  });

  test("an empty section is reported as such", async () => {
    const { service } = setup({});
    const page = await service.getSection({ section: "honors" });
    assert.deepEqual(page.items, []);
    assert.equal(page.total, 0);
    assert.deepEqual(page.freshness.empty, ["honors"]);
  });

  test("blocked and unknown sections are usage errors that never reach LinkedIn", async () => {
    const { fake, service } = setup({});
    await assert.rejects(service.getSection({ section: "inbox" }), /not available/);
    await assert.rejects(service.getSection({ section: "POSITIONS" }), UsageError);
    assert.equal(fake.urls.length, 0);
  });

  test("snapshot API errors surface as LinkedInApiError", async () => {
    const impl = (async () => new Response(JSON.stringify({ message: "denied" }), { status: 403 })) as typeof fetch;
    const service = createService({
      client: new LinkedInClient({ fetchImpl: impl, maxRetries: 0 }),
      cache: new Cache({ token: TOKEN }),
      accessToken: TOKEN,
    });
    await assert.rejects(service.getSection({ section: "skills" }), LinkedInApiError);
  });
});

describe("getRecentActivity", () => {
  const events = [
    peopleEvent({ headline: "Newer headline" }, NOW - 1 * DAY),
    likeEvent("urn:li:activity:111111111111", { capturedAt: NOW - 10 * DAY }),
    commentEvent("urn:li:activity:222222222222", "5", "hello", { capturedAt: NOW - 20 * DAY }),
  ];

  test("defaults to the last 28 days, newest first", async () => {
    const { service } = setup({ events });
    const page = await service.getRecentActivity();
    assert.equal(page.total, 3);
    assert.deepEqual(page.items.map((i) => i.section), ["intro", "reactions", "comments"]);
    assert.equal(page.since, new Date(NOW - 28 * DAY).toISOString());
  });

  test("since accepts 7d, an ISO date and epoch ms", async () => {
    const { service } = setup({ events });
    assert.equal((await service.getRecentActivity({ since: "7d" })).total, 1);
    assert.equal((await service.getRecentActivity({ since: new Date(NOW - 15 * DAY).toISOString() })).total, 2);
    assert.equal((await service.getRecentActivity({ since: String(NOW - 25 * DAY) })).total, 3);
    assert.equal((await service.getRecentActivity({ since: "12h" })).total, 0);
  });

  test("a cursor pins `since`: page 2 keeps the window and the total of page 1 whatever `since` it is given", async () => {
    const wide = setup({ events: [...events, likeEvent("urn:li:activity:333333333333", { capturedAt: NOW - 2 * DAY })] });
    const w1 = await wide.service.getRecentActivity({ since: "7d", limit: 1 });
    assert.equal(w1.total, 2);
    assert.ok(w1.nextCursor);
    const w2 = await wide.service.getRecentActivity({ since: "28d", limit: 1, cursor: w1.nextCursor });
    assert.equal(w2.since, w1.since);
    assert.equal(w2.since, new Date(NOW - 7 * DAY).toISOString());
    assert.equal(w2.total, 2);
    assert.equal(w2.items.length, 1);
    assert.equal(w2.nextCursor, undefined);
    const w3 = await wide.service.getRecentActivity({ limit: 1, cursor: w1.nextCursor });
    assert.equal(w3.since, w1.since);
    assert.equal(w3.total, 2);
  });

  test("an event exactly at the since instant is included; one millisecond earlier is not", async () => {
    const since = NOW - 5 * DAY;
    const { service } = setup({
      events: [
        likeEvent("urn:li:activity:111111111111", { capturedAt: since }),
        likeEvent("urn:li:activity:222222222222", { capturedAt: since - 1 }),
        likeEvent("urn:li:activity:333333333333", { capturedAt: since + 1 }),
      ],
    });
    const page = await service.getRecentActivity({ since: String(since) });
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map((i) => i.summary.slice(-12)), ["333333333333", "111111111111"]);
  });

  test("the changelog is requested from now minus 28 days plus a 5 minute margin", async () => {
    const { service, fake } = setup({ events: [] });
    await service.getRecentActivity();
    const requests = fake.urls.filter((u) => u.pathname === "/rest/memberChangeLogs");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.searchParams.get("startTime"), String(NOW - 28 * DAY + 5 * 60_000));
  });

  test("a bad since is a usage error", async () => {
    const { service } = setup({ events });
    for (const since of ["banana", "7x", "-3d"]) {
      await assert.rejects(service.getRecentActivity({ since }), UsageError, since);
    }
  });

  test("pages with cursors and rejects a stale one", async () => {
    const { service, clock: c } = setup({ events });
    const p1 = await service.getRecentActivity({ limit: 2 });
    assert.equal(p1.items.length, 2);
    const p2 = await service.getRecentActivity({ limit: 2, cursor: p1.nextCursor });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.nextCursor, undefined);
    c.advance(1000);
    await service.getRecentActivity({ refresh: true });
    await assert.rejects(service.getRecentActivity({ limit: 2, cursor: p1.nextCursor }), /data changed/);
  });

  test("a changelog failure is an error here", async () => {
    const { service } = setup({ changelogStatus: 403 });
    await assert.rejects(service.getRecentActivity(), LinkedInApiError);
  });

  test("contains no raw LinkedIn resource names", async () => {
    const { service } = setup({ events });
    const text = JSON.stringify(await service.getRecentActivity());
    assert.doesNotMatch(text, /socialActions|resourceName|people\//);
  });
});

describe("checkAccess", () => {
  test("with several authorizations, tracking started at the earliest one, in any order", async () => {
    for (const regulatedAt of [[T(12), T(10)], [T(10), T(12)]]) {
      const { service } = setup({ authorizations: regulatedAt.map((value) => ({ regulatedAt: value })) });
      assert.deepEqual(await service.checkAccess(), { connected: true, trackingChangesSince: new Date(T(10)).toISOString() });
    }
  });

  test("an authorization without regulatedAt still means connected, with no tracking time", async () => {
    const { service } = setup({ authorizations: [{ memberComplianceScopes: ["DMA"] }] });
    const status = await service.checkAccess();
    assert.deepEqual(status, { connected: true });
    assert.equal("trackingChangesSince" in status, false);
  });

  test("not connected when there is no authorization", async () => {
    const { service } = setup({ authorizations: [] });
    assert.deepEqual(await service.checkAccess(), { connected: false });
  });
});

describe("disk cache contents", () => {
  test("never contain redacted fields, the token or LinkedIn domain names", async () => {
    const dir = await tempDir();
    const { service } = setup(
      {
        snapshots: {
          ...baseSnapshots,
          ALL_LIKES: reactionRows(5),
          CONNECTIONS: [{ "First Name": "Bo", "Email Address": "bo@example.com", Company: "X" }],
          JOB_APPLICATIONS: [{ "Company Name": "Y", "Contact Email": "me@example.com", "Contact Phone Number": "123", "Resume Name": "cv.pdf" }],
        },
        events: [
          likeEvent("urn:li:activity:9999999999999", { capturedAt: T(24) }),
          event({ resourceName: "messages", method: "CREATE", activity: { body: "secret message body" } }),
          peopleEvent({ headline: "H", birthDate: "secret-birth" }, T(23)),
        ],
      },
      { cacheDir: dir },
    );
    await service.getProfile();
    await service.getSection({ section: "reactions" });
    await service.getSection({ section: "connections" });
    await service.getSection({ section: "job-applications" });
    await service.getRecentActivity();

    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        out.push(p, ...(entry.isDirectory() ? await walk(p) : [await readFile(p, "utf8")]));
      }
      return out;
    };
    const everything = (await walk(dir)).join("\n");
    assert.ok(everything.length > 100);
    for (const forbidden of [
      "birthDate", "Birth Date", "zipCode", "Zip Code", "address", "Address", "emailAddress", "Email Address",
      "contactEmail", "contactPhoneNumber", "resumeName", "secret-birth", "bo@example.com", "me@example.com", "cv.pdf",
      TOKEN, "POSITIONS", "PROFILE", "ALL_LIKES", "CONNECTIONS", "JOB_APPLICATIONS", "snapshotDomain", "secret message body",
    ]) {
      assert.ok(!everything.includes(forbidden), forbidden);
    }
  });
});

describe("cursors", () => {
  const rows = reactionRows(10);
  const comment = { Date: "2026-09-01 10:00:00", Link: "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A1", Message: "hi" };
  const events = [peopleEvent({ headline: "New" }, T(24)), likeEvent("urn:li:activity:111111111111", { capturedAt: T(24) })];
  const manyComments = Array.from({ length: 10 }, (_, i) => ({ ...comment, Message: `m${i}` }));
  const options = { snapshots: { ALL_LIKES: rows, ALL_COMMENTS: manyComments }, events };

  test("a cursor only works for the section that issued it", async () => {
    const { service } = setup(options);
    const reactionsPage = await service.getSection({ section: "reactions", limit: 2 });
    assert.ok(reactionsPage.nextCursor);
    await assert.rejects(service.getSection({ section: "comments", limit: 2, cursor: reactionsPage.nextCursor }), /different/i);
    assert.equal((await service.getSection({ section: "reactions", limit: 2, cursor: reactionsPage.nextCursor })).items.length, 2);
  });

  test("section cursors and activity cursors are not interchangeable", async () => {
    const { service } = setup({ ...options, events: [...events, likeEvent("urn:li:activity:222222222222", { capturedAt: T(23) }), likeEvent("urn:li:activity:333333333333", { capturedAt: T(22) })] });
    const activity = await service.getRecentActivity({ limit: 1, since: "28d" });
    const section = await service.getSection({ section: "reactions", limit: 1 });
    assert.ok(activity.nextCursor && section.nextCursor);
    await assert.rejects(service.getSection({ section: "reactions", cursor: activity.nextCursor }), /different/i);
    await assert.rejects(service.getRecentActivity({ cursor: section.nextCursor }), /different/i);
  });

  test("a wrong-section cursor is refused before anything is fetched", async () => {
    const { service, fake } = setup(options);
    const cursor = Buffer.from(JSON.stringify({ scope: "comments", offset: 1, asOf: NOW })).toString("base64url");
    await assert.rejects(service.getSection({ section: "reactions", cursor }), UsageError);
    assert.equal(fake.urls.length, 0);
  });

  test("tampered cursors are usage errors; an offset past the end is an empty last page", async () => {
    const { service } = setup(options);
    const first = await service.getSection({ section: "reactions", limit: 2 });
    const good = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    const encode = (patch: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...good, ...patch })).toString("base64url");
    for (const patch of [{ offset: -1 }, { offset: 1.5 }, { offset: "2" }, { offset: null }, { offset: 1e999 }, { asOf: "x" }, { scope: 5 }, { scope: undefined }]) {
      await assert.rejects(service.getSection({ section: "reactions", cursor: encode(patch) }), UsageError, JSON.stringify(patch));
    }
    for (const junk of ["", "%%%", "e30", Buffer.from("[]").toString("base64url"), Buffer.from("null").toString("base64url"), Buffer.from("not json").toString("base64url")]) {
      await assert.rejects(service.getSection({ section: "reactions", cursor: junk }), UsageError, junk);
    }
    const past = await service.getSection({ section: "reactions", limit: 2, cursor: encode({ offset: 10_000 }) });
    assert.deepEqual(past.items, []);
    assert.equal(past.total, 11);
    assert.equal(past.nextCursor, undefined);
  });

  test("page boundaries: total equal to the limit, one more than the limit, and zero items", async () => {
    const exact = setup({ snapshots: { ALL_LIKES: reactionRows(5) } });
    const a = await exact.service.getSection({ section: "reactions", limit: 5 });
    assert.equal(a.items.length, 5);
    assert.equal(a.nextCursor, undefined);
    const over = setup({ snapshots: { ALL_LIKES: reactionRows(6) } });
    const b = await over.service.getSection({ section: "reactions", limit: 5 });
    assert.equal(b.items.length, 5);
    const b2 = await over.service.getSection({ section: "reactions", limit: 5, cursor: b.nextCursor });
    assert.equal(b2.items.length, 1);
    assert.equal(b2.nextCursor, undefined);
    const none = setup({ snapshots: { ALL_LIKES: [] } });
    const c = await none.service.getSection({ section: "reactions", limit: 5 });
    assert.deepEqual([c.items, c.total, c.nextCursor], [[], 0, undefined]);
  });

  test("with the cache off, paging still works instead of failing with 'data changed'", async () => {
    const { service, clock: c } = setup({ snapshots: { ALL_LIKES: reactionRows(5) } }, { ttlMs: 0 });
    const first = await service.getSection({ section: "reactions", limit: 2 });
    c.advance(5000);
    const second = await service.getSection({ section: "reactions", limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 2);
    assert.ok(second.nextCursor);
  });

  test("limits: 1.5 is floored, Infinity returns everything, NaN and 0 are usage errors", async () => {
    const { service } = setup({ snapshots: { ALL_LIKES: reactionRows(5) } });
    assert.equal((await service.getSection({ section: "reactions", limit: 1.5 })).items.length, 1);
    assert.equal((await service.getSection({ section: "reactions", limit: Number.POSITIVE_INFINITY })).items.length, 5);
    for (const limit of [Number.NaN, 0, -1, 0.5]) {
      await assert.rejects(service.getSection({ section: "reactions", limit }), UsageError, String(limit));
    }
  });

  test("profile refuses all together with a list of sections", async () => {
    const { service, fake } = setup(options);
    await assert.rejects(service.getProfile({ all: true, sections: ["skills"] }), UsageError);
    assert.equal(fake.urls.length, 0);
    // An empty list of sections means "no list": `all` then embeds every résumé section.
    const emptyList = await service.getProfile({ all: true, sections: [] });
    assert.deepEqual(Object.keys(emptyList), [...RESUME_KEYS, "related", "freshness"]);
  });
});

describe("a truncated snapshot is reported as incomplete (the 50 page cap is the real-world case)", () => {
  test("profile: an endless snapshot sets freshness.incomplete", async () => {
    const { service, fake } = setup({ snapshots: baseSnapshots, snapshotEndless: true });
    const profile = await service.getProfile({ sections: ["skills"] });
    assert.equal(profile.freshness.incomplete, true);
    assert.equal(fake.urls.filter((u) => u.pathname === "/rest/memberSnapshotData").length, 50);
  });

  test("section: an endless snapshot sets freshness.incomplete, and a complete one does not", async () => {
    const endless = setup({ snapshots: { ALL_LIKES: reactionRows(5) }, snapshotEndless: true });
    assert.equal((await endless.service.getSection({ section: "reactions" })).freshness.incomplete, true);
    const complete = setup({ snapshots: { ALL_LIKES: reactionRows(5) } });
    const page = await complete.service.getSection({ section: "reactions" });
    assert.equal("incomplete" in page.freshness, false);
  });
});

describe("a tampered activity cursor", () => {
  const encodeText = (text: string) => Buffer.from(text).toString("base64url");

  test("with a bad or out-of-range `since` is a usage error, never a RangeError", async () => {
    const { service, fake } = setup({ events: [] });
    const cursors = [
      `{"scope":"activity","offset":1,"asOf":${NOW},"since":"x"}`,
      `{"scope":"activity","offset":1,"asOf":${NOW},"since":null}`,
      `{"scope":"activity","offset":1,"asOf":${NOW},"since":1e999}`,
      `{"scope":"activity","offset":1,"asOf":${NOW},"since":1e300}`,
      `{"scope":"activity","offset":1,"asOf":${NOW},"since":-1e300}`,
    ];
    for (const text of cursors) {
      await assert.rejects(service.getRecentActivity({ cursor: encodeText(text) }), UsageError, text);
    }
    assert.equal(fake.urls.length, 0);
  });

  test("a well-formed `since` is honoured", async () => {
    const { service } = setup({ events: [likeEvent("urn:li:activity:111111111111", { capturedAt: NOW - DAY })] });
    const first = await service.getRecentActivity();
    const cursor = encodeText(`{"scope":"activity","offset":0,"asOf":${NOW},"since":${NOW - 7 * DAY}}`);
    const page = await service.getRecentActivity({ cursor });
    assert.equal(page.since, new Date(NOW - 7 * DAY).toISOString());
    assert.equal(page.total, first.total);
  });
});

describe("parseSince", () => {
  const now = 1_800_000_000_000;

  test("durations are exact, in any letter case: 1w is 7 days", () => {
    assert.equal(parseSince("1w", now), now - 604_800_000);
    assert.equal(parseSince("2d", now), now - 172_800_000);
    assert.equal(parseSince("12h", now), now - 43_200_000);
    assert.equal(parseSince("90m", now), now - 5_400_000);
    assert.equal(parseSince("7D", now), now - 604_800_000);
    assert.equal(parseSince("1W", now), now - 604_800_000);
    assert.equal(parseSince(" 3H ", now), now - 10_800_000);
  });

  test("no value means the full 28 day window", () => {
    assert.equal(parseSince(undefined, now), now - 2_419_200_000);
    assert.equal(parseSince("  ", now), now - 2_419_200_000);
  });

  test("epoch milliseconds: 12 and 13 digits are taken as they are", () => {
    assert.equal(parseSince("100000000000", now), 100_000_000_000);
    assert.equal(parseSince("1790000000000", now), 1_790_000_000_000);
  });

  test("9 to 11 digit values are recognised as epoch seconds with a hint; 8 digits are just invalid", () => {
    for (const digits of ["123456789", "1700000000", "17000000000"]) {
      assert.throws(
        () => parseSince(digits, now),
        new UsageError(`Invalid since value "${digits}". That looks like epoch seconds; give epoch milliseconds (13 digits) instead, or a duration like 7d.`),
        digits,
      );
    }
    assert.throws(
      () => parseSince("12345678", now),
      new UsageError('Invalid since value "12345678". Use a duration like 7d or 12h, an ISO date, or epoch milliseconds.'),
    );
  });

  test("ISO dates parse; impossible dates and junk do not", () => {
    assert.equal(parseSince("2026-09-01", now), Date.UTC(2026, 8, 1));
    assert.equal(parseSince("2026-09-01T10:30:00Z", now), Date.UTC(2026, 8, 1, 10, 30));
    for (const bad of ["2026-02-30", "2026-13-01", "junk", "7x", "-3d", "d7"]) {
      assert.throws(() => parseSince(bad, now), UsageError, bad);
    }
  });
});

describe("default page size", () => {
  test("a section without a limit returns 50 items, the total, and a cursor for the rest", async () => {
    const { service } = setup({ snapshots: { ALL_LIKES: reactionRows(120) } });
    const page = await service.getSection({ section: "reactions" });
    assert.equal(page.items.length, 50);
    assert.equal(page.total, 120);
    assert.equal(typeof page.nextCursor, "string");
    const second = await service.getSection({ section: "reactions", cursor: page.nextCursor });
    assert.equal(second.items.length, 50);
    assert.equal(second.total, 120);
  });

  test("recent activity without a limit returns 50 items, the total, and a cursor for the rest", async () => {
    const events = Array.from({ length: 60 }, (_, i) => likeEvent(`urn:li:activity:${100000000000 + i}`, { capturedAt: NOW - (i + 1) * 60_000 }));
    const { service } = setup({ events });
    const page = await service.getRecentActivity();
    assert.equal(page.items.length, 50);
    assert.equal(page.total, 60);
    assert.equal(typeof page.nextCursor, "string");
    assert.equal((await service.getRecentActivity({ cursor: page.nextCursor })).items.length, 10);
  });
});

describe("freshness.asOf is the oldest input, not the newest and not now", () => {
  const HOUR = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  test("a section whose changelog was fetched first reports that time, though its snapshot is an hour newer", async () => {
    const { service, clock: c } = setup({ snapshots: baseSnapshots, events: [] });
    await service.getRecentActivity(); // the changelog is cached at NOW
    c.advance(HOUR);
    const page = await service.getSection({ section: "experience" }); // its snapshot is fetched at NOW + 1h
    assert.equal(page.freshness.asOf, iso(NOW));
  });

  test("a section whose snapshot was fetched first reports that time, though its changelog is an hour newer", async () => {
    const { service, clock: c } = setup({ snapshots: baseSnapshots, events: [] });
    await service.getSection({ section: "skills" }); // snapshot and changelog at NOW
    c.advance(HOUR);
    await service.getRecentActivity({ refresh: true }); // a newer changelog at NOW + 1h
    const page = await service.getSection({ section: "skills" });
    assert.equal(page.freshness.asOf, iso(NOW));
  });

  test("recent activity keeps the time its changelog was fetched on a second, cached call", async () => {
    const { service, clock: c } = setup({ events: [] });
    const first = await service.getRecentActivity();
    c.advance(HOUR);
    const second = await service.getRecentActivity();
    assert.equal(first.freshness.asOf, iso(NOW));
    assert.equal(second.freshness.asOf, iso(NOW));
    const refreshed = await service.getRecentActivity({ refresh: true });
    assert.equal(refreshed.freshness.asOf, iso(NOW + HOUR));
  });
});

describe("cache files that are almost valid are refetched, never used and never a crash", () => {
  const NAMESPACE = "f32f38539b47ca71"; // sha256(TOKEN)[0:16]
  const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

  const goodSnapshot = { rows: [{ name: "Cached" }], empty: false, truncated: false };
  const goodEvent = { activityId: "a-1", capturedAt: NOW - DAY, method: "PARTIAL_UPDATE", resourceName: "people", activity: { headline: "Cached headline" } };
  const goodChangelog = { events: [goodEvent], truncated: false };

  async function seed(name: string, data: unknown): Promise<string> {
    const dir = await tempDir();
    await mkdir(join(dir, "unlinked", NAMESPACE), { recursive: true });
    await writeFile(join(dir, "unlinked", NAMESPACE, name), JSON.stringify({ fetchedAt: NOW, data }));
    return dir;
  }

  const snapshotCase = async (data: unknown) => {
    const dir = await seed("snapshot_skills.json", data);
    const { service, fake } = setup({ snapshots: { SKILLS: [{ Name: "Fresh" }] } }, { cacheDir: dir });
    const page = await service.getSection({ section: "skills" });
    return { items: page.items, domains: fake.domains() };
  };

  const changelogCase = async (data: unknown) => {
    const dir = await seed("changelog_28d.json", data);
    const { service, fake } = setup({ events: [likeEvent("urn:li:activity:111111111111", { capturedAt: NOW - DAY })] }, { cacheDir: dir });
    const page = await service.getRecentActivity();
    return { sections: page.items.map((i) => i.section), requests: fake.changelogRequests() };
  };

  test("control: a fully valid snapshot file is used without any request", async () => {
    assert.deepEqual(await snapshotCase(goodSnapshot), { items: [{ name: "Cached" }], domains: [] });
  });

  test("control: a fully valid changelog file is used without any request", async () => {
    assert.deepEqual(await changelogCase(goodChangelog), { sections: ["intro"], requests: 0 });
  });

  const badSnapshots: Array<[string, unknown]> = [
    ["rows holding a number", { ...goodSnapshot, rows: [5] }],
    ["rows holding null", { ...goodSnapshot, rows: [null] }],
    ["rows holding an array", { ...goodSnapshot, rows: [[]] }],
    ["rows that is not an array", { ...goodSnapshot, rows: "nope" }],
    ["no rows", without(goodSnapshot, "rows")],
    ["no empty flag", without(goodSnapshot, "empty")],
    ["an empty flag that is not a boolean", { ...goodSnapshot, empty: "no" }],
    ["no truncated flag", without(goodSnapshot, "truncated")],
    ["a truncated flag that is not a boolean", { ...goodSnapshot, truncated: 0 }],
    ["an array instead of the entry", []],
  ];
  for (const [name, data] of badSnapshots) {
    test(`snapshot file with ${name}`, async () => {
      assert.deepEqual(await snapshotCase(data), { items: [{ name: "Fresh" }], domains: ["SKILLS"] });
    });
  }

  const badChangelogs: Array<[string, unknown]> = [
    ["an event without activityId", { ...goodChangelog, events: [without(goodEvent, "activityId")] }],
    ["an event whose activityId is a number", { ...goodChangelog, events: [{ ...goodEvent, activityId: 7 }] }],
    ["an event without capturedAt", { ...goodChangelog, events: [without(goodEvent, "capturedAt")] }],
    ["an event whose capturedAt is text", { ...goodChangelog, events: [{ ...goodEvent, capturedAt: "yesterday" }] }],
    ["an event without method", { ...goodChangelog, events: [without(goodEvent, "method")] }],
    ["an event without resourceName", { ...goodChangelog, events: [without(goodEvent, "resourceName")] }],
    ["an event without activity", { ...goodChangelog, events: [without(goodEvent, "activity")] }],
    ["an event whose activity is a list", { ...goodChangelog, events: [{ ...goodEvent, activity: [] }] }],
    ["a null event", { ...goodChangelog, events: [goodEvent, null] }],
    ["events that is not an array", { ...goodChangelog, events: "nope" }],
    ["no truncated flag", without(goodChangelog, "truncated")],
    ["a truncated flag that is not a boolean", { ...goodChangelog, truncated: "false" }],
  ];
  for (const [name, data] of badChangelogs) {
    test(`changelog file with ${name}`, async () => {
      assert.deepEqual(await changelogCase(data), { sections: ["reactions"], requests: 1 });
    });
  }
});
