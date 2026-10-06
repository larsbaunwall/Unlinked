import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildActivityFeed, cleanChangelog, findPendingEdits, mergeComments, mergeIntro, mergePosts, mergeReactions } from "../src/linkedin/merge.js";
import { Cache } from "../src/cache.js";
import { LinkedInClient } from "../src/linkedin/client.js";
import { createService } from "../src/service.js";
import { commentEvent, event, likeEvent, peopleEvent, postEvent, T } from "./helpers/events.js";
import { linkedinFake } from "./helpers/linkedin-fake.js";

const reactionRow = (n: number) => ({
  date: "2026-09-10 10:00:00",
  type: "LIKE",
  link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + n}`,
});

describe("a __proto__ key in an activity", () => {
  test("is an ordinary dropped key: it cannot lend fields to the cleaned activity through the prototype", () => {
    const activity = JSON.parse('{"headline":"Real","__proto__":{"lastName":"Injected","firstName":"Injected"}}');
    const [cleaned] = cleanChangelog([event({ resourceName: "people", method: "PARTIAL_UPDATE", capturedAt: T(20), activity })]);
    assert.deepEqual(cleaned!.activity, { headline: "Real" });
  });
});

describe("odd events never throw and never change anything", () => {
  const odd: unknown[] = [
    null,
    undefined,
    7,
    "text",
    [],
    {},
    { resourceName: 5, method: "CREATE", capturedAt: 1 },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: "yesterday", activity: { object: "urn:li:activity:1" } },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: Number.NaN, activity: { object: "urn:li:activity:1" } },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: Number.POSITIVE_INFINITY, activity: { object: "urn:li:activity:1" } },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: 1e20, activity: { object: "urn:li:activity:1" } },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: -1e20, activity: { object: "urn:li:activity:1" } },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: T(20) }, // no activity
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: T(20), activity: null },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: T(20), activity: [] },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: T(20), activity: "str" },
    { resourceName: "socialActions/likes", method: "CREATE", capturedAt: T(20), activity: { object: 42, reactionType: {} } },
    { resourceName: "socialActions/likes", method: "DELETE", capturedAt: T(20), resourceUri: 5 },
    { resourceName: "socialActions/comments", method: "CREATE", capturedAt: T(20), activity: { object: "urn:li:activity:1", message: { text: 5 } } },
    { resourceName: "socialActions/comments", method: "CREATE", capturedAt: T(20), activity: { object: "urn:li:activity:1", message: "flat" } },
    { resourceName: "socialActions/comments", method: "CREATE", capturedAt: T(20), activity: { message: { text: "no object" } } },
    { resourceName: "ugcPosts", method: "CREATE", capturedAt: T(20), activity: { specificContent: "x", visibility: [] } },
    { resourceName: "people", method: "PARTIAL_UPDATE", capturedAt: T(20), activity: { headline: { localized: null }, summary: 5, firstName: {} } },
    { resourceName: "people/positions", method: "PARTIAL_UPDATE", capturedAt: T(20), activity: { description: { localized: { en_US: 5 } } } },
  ];

  test("cleaning, merging, the feed and pending-edit detection survive all of them", () => {
    const cleaned = cleanChangelog(odd);
    const rows = [reactionRow(1)];
    assert.deepEqual(mergeReactions(rows, cleaned).items, rows);
    assert.deepEqual(mergeComments([], cleaned).items, []);
    assert.deepEqual(mergePosts([], cleaned).items, []);
    assert.deepEqual(mergeIntro({ headline: "Keep" }, cleaned).intro, { headline: "Keep" });
    assert.deepEqual(findPendingEdits(cleaned, { experience: [{ title: "x" }] }), []);
    // The only odd event that still says something true is the position edit (its description is not text).
    assert.deepEqual(buildActivityFeed(cleaned), [
      { at: "2026-09-20T10:00:00.000Z", section: "experience", change: "edited", summary: "Position edited" },
    ]);
  });
});

describe("duplicate and replayed events", () => {
  test("the same activityId delivered twice adds one reaction", () => {
    const object = "urn:li:activity:111111111111";
    const first = likeEvent(object, { capturedAt: T(20), activityId: "dup" });
    const again = likeEvent(object, { capturedAt: T(20), activityId: "dup" });
    const result = mergeReactions([], cleanChangelog([first, again]));
    assert.equal(result.items.length, 1);
    assert.equal(result.applied, 1);
  });

  test("two SUCCESS events with one activityId are one event, even when they name different objects (the later wins)", () => {
    const early = likeEvent("urn:li:activity:111111111111", { capturedAt: T(20), activityId: "shared" });
    const late = likeEvent("urn:li:activity:222222222222", { capturedAt: T(21), activityId: "shared" });
    const cleaned = cleanChangelog([early, late]);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0]!.activity.object, "urn:li:activity:222222222222");
    const feed = buildActivityFeed(cleaned);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.summary, "LIKE https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A222222222222");
    assert.equal(mergeReactions([], cleaned).items.length, 1);
  });

  test("different activityIds with the same object are not collapsed by cleanChangelog", () => {
    const cleaned = cleanChangelog([
      likeEvent("urn:li:activity:111111111111", { capturedAt: T(20), activityId: "a" }),
      likeEvent("urn:li:activity:111111111111", { capturedAt: T(21), activityId: "b" }),
    ]);
    assert.equal(cleaned.length, 2);
  });

  test("FAILURE then SUCCESSFUL_REPLAY adds one reaction; a lone FAILURE adds none", () => {
    const object = "urn:li:activity:111111111111";
    const failure = likeEvent(object, { capturedAt: T(20), activityId: "r1" });
    failure.activityStatus = "FAILURE";
    const replay = likeEvent(object, { capturedAt: T(20), activityId: "r1" });
    replay.activityStatus = "SUCCESSFUL_REPLAY";
    assert.equal(mergeReactions([], cleanChangelog([failure, replay])).items.length, 1);
    assert.equal(mergeReactions([], cleanChangelog([failure])).items.length, 0);
  });

  test("a failed DELETE does not remove the reaction", () => {
    const object = "urn:li:activity:111111111111";
    const failedDelete = likeEvent(object, { capturedAt: T(21), method: "DELETE", activityId: "d1" });
    failedDelete.activityStatus = "FAILURE";
    const rows = [{ date: "2026-09-01 10:00:00", type: "LIKE", link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A111111111111` }];
    assert.equal(mergeReactions(rows, cleanChangelog([failedDelete])).items.length, 1);
  });

  test("events without an activityId are all kept, not collapsed into one", () => {
    const a = likeEvent("urn:li:activity:111111111111", { capturedAt: T(20) });
    const b = likeEvent("urn:li:activity:222222222222", { capturedAt: T(21) });
    delete a.activityId;
    delete b.activityId;
    assert.equal(mergeReactions([], cleanChangelog([a, b])).items.length, 2);
  });

  test("two CREATEs of the same comment id add one comment; DELETE after UPDATE removes it", () => {
    const create = (activityId: string) => ({ ...commentEvent("urn:li:activity:222222222222", "9", "hello", { capturedAt: T(20) }), activityId });
    const merged = mergeComments([], cleanChangelog([create("c1"), create("c2")]));
    assert.equal(merged.items.length, 1);
    const update = commentEvent("urn:li:activity:222222222222", "9", "hello edited", { capturedAt: T(21), method: "UPDATE" });
    update.activity = { id: "9", object: "urn:li:activity:222222222222", message: { text: "hello edited" } };
    const del = commentEvent("urn:li:activity:222222222222", "9", "", { capturedAt: T(22), method: "DELETE" });
    const events = cleanChangelog([create("c1"), update, del]);
    assert.deepEqual(mergeComments([], events).items, []);
    assert.equal(mergeComments([], cleanChangelog([create("c1"), update])).items[0]?.message, "hello edited");
  });
});

describe("merge details", () => {
  test("a whitespace-only headline leaves the intro unchanged and applies nothing", () => {
    const intro = { headline: "Keep", about: "About" };
    const merged = mergeIntro(intro, cleanChangelog([peopleEvent({ headline: "   " }, T(20))]));
    assert.deepEqual(merged, { intro: { headline: "Keep", about: "About" }, applied: 0 });
    const blank = mergeIntro(intro, cleanChangelog([peopleEvent({ headline: "", summary: "\n\t" }, T(20))]));
    assert.deepEqual(blank, { intro: { headline: "Keep", about: "About" }, applied: 0 });
  });

  test("deleting post A then creating a different post B with the same text leaves exactly one post", () => {
    const row = {
      date: "2026-09-10 09:00:00",
      shareLink: "https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A111",
      shareCommentary: "Same words",
    };
    const merged = mergePosts(
      [row],
      cleanChangelog([
        postEvent("urn:li:ugcPost:111", undefined, { capturedAt: T(20), method: "DELETE" }),
        postEvent("urn:li:ugcPost:222", "Same words", { capturedAt: T(21) }),
      ]),
    );
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0]!.shareLink, "https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A222");
    assert.equal(merged.applied, 2);
  });

  test("a comment edited away from text A frees that text for a later comment on the same post", () => {
    const post = "urn:li:activity:111111111111";
    const merged = mergeComments(
      [],
      cleanChangelog([
        commentEvent(post, "id1", "A", { capturedAt: T(20) }),
        commentEvent(post, "id1", "B", { capturedAt: T(21), method: "UPDATE" }),
        commentEvent(post, "id2", "A", { capturedAt: T(22) }),
      ]),
    );
    assert.deepEqual(merged.items.map((item) => item.message).sort(), ["A", "B"]);
    assert.equal(merged.applied, 3);
  });
});

describe("blocked and unknown resources", () => {
  test("inbox, invitations, contact details and unknown resources are dropped entirely", () => {
    const cleaned = cleanChangelog([
      event({ resourceName: "messages", method: "CREATE", activity: { text: "secret dm", name: "secret" } }),
      event({ resourceName: "invitations", method: "ACTION", activity: { message: "secret" } }),
      event({ resourceName: "people/emailAddresses", method: "CREATE", activity: { name: "secret@example.com", text: "secret" } }),
      event({ resourceName: "people/phoneNumbers", method: "CREATE", activity: { text: "+4500000000" } }),
      event({ resourceName: "people/positions/extra/deep", method: "CREATE", activity: { title: "secret" } }),
      event({ resourceName: "somethingNew", method: "CREATE", activity: { text: "secret" } }),
    ]);
    assert.deepEqual(cleaned, []);
  });
});

describe("merging scales linearly", () => {
  // A deterministic complexity check instead of a wall-clock one: every snapshot row exposes a counting getter, and a
  // per-event scan over the rows (quadratic) would read it rows x events times, where one pass reads it about once per row.
  function counted<T extends Record<string, unknown>>(row: T, field: keyof T & string, counter: { reads: number }): T {
    const copy: Record<string, unknown> = { ...row };
    const value = copy[field];
    Object.defineProperty(copy, field, { enumerable: true, get: () => (counter.reads++, value) });
    return copy as T;
  }
  const ROWS = 1000;
  const EVENTS = 500;

  test("reactions: link reads stay near rows + events, not rows x events", () => {
    const counter = { reads: 0 };
    const rows = Array.from({ length: ROWS }, (_, i) => counted(reactionRow(i), "link", counter));
    const events = cleanChangelog(Array.from({ length: EVENTS }, (_, i) => likeEvent(`urn:li:activity:${9000000000000 + i}`, { capturedAt: T(20) + i * 1000 })));
    const merged = mergeReactions(rows, events);
    assert.equal(merged.items.length, ROWS + EVENTS);
    assert.equal(merged.applied, EVENTS);
    assert.ok(counter.reads <= 3 * (ROWS + EVENTS), `link was read ${counter.reads} times`);
  });

  test("comments: link reads stay near rows + events", () => {
    const counter = { reads: 0 };
    const rows = Array.from({ length: ROWS }, (_, i) =>
      counted({ date: "2026-09-10 10:00:00", link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${i}`, message: `m${i}` }, "link", counter),
    );
    const events = cleanChangelog(Array.from({ length: EVENTS }, (_, i) => commentEvent(`urn:li:activity:${9000000000000 + i}`, String(i), `new${i}`, { capturedAt: T(20) + i * 1000 })));
    const merged = mergeComments(rows, events);
    assert.equal(merged.items.length, ROWS + EVENTS);
    assert.ok(counter.reads <= 3 * (ROWS + EVENTS), `link was read ${counter.reads} times`);
  });

  test("posts: shareLink reads stay near rows + events", () => {
    const counter = { reads: 0 };
    const rows = Array.from({ length: ROWS }, (_, i) =>
      counted({ date: "2026-09-10 10:00:00", shareLink: `https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A${i}`, shareCommentary: `post ${i}` }, "shareLink", counter),
    );
    const events = cleanChangelog(Array.from({ length: EVENTS }, (_, i) => postEvent(`urn:li:ugcPost:${5000 + i}`, `new post ${i}`, { capturedAt: T(20) + i * 1000 })));
    assert.equal(mergePosts(rows, events).items.length, ROWS + EVENTS);
    assert.ok(counter.reads <= 3 * (ROWS + EVENTS), `shareLink was read ${counter.reads} times`);
  });
});

describe("service level", () => {
  const setup = (options: Parameters<typeof linkedinFake>[0]) => {
    const fake = linkedinFake(options);
    const service = createService({
      client: new LinkedInClient({ fetchImpl: fake.impl, maxRetries: 0 }),
      cache: new Cache({ token: "t", now: () => T(25) }),
      accessToken: "t",
      now: () => T(25),
    });
    return { fake, service };
  };

  test("an empty snapshot plus changelog events gives the merged items and is not reported as empty", async () => {
    const { service } = setup({ events: [likeEvent("urn:li:activity:111111111111", { capturedAt: T(24) }), commentEvent("urn:li:activity:222222222222", "3", "hi", { capturedAt: T(24) })] });
    const reactions = await service.getSection({ section: "reactions" });
    assert.equal(reactions.total, 1);
    assert.deepEqual(reactions.freshness.empty, []);
    const comments = await service.getSection({ section: "comments" });
    assert.equal(comments.total, 1);
    assert.deepEqual(comments.freshness.empty, []);
  });

  test("an empty snapshot and no events is reported as empty", async () => {
    const { service } = setup({ events: [] });
    const page = await service.getSection({ section: "reactions" });
    assert.deepEqual([page.total, page.freshness.empty], [0, ["reactions"]]);
  });

  test("a changelog with zero events changes nothing and flags nothing", async () => {
    const { service } = setup({ snapshots: { PROFILE: [{ Headline: "H" }], POSITIONS: [{ Title: "T" }] }, events: [] });
    const profile = await service.getProfile();
    const { freshness } = profile as { freshness: { recentChangesMerged: number; pendingEdits: string[]; recentChangesError?: string } };
    assert.equal(freshness.recentChangesMerged, 0);
    assert.deepEqual(freshness.pendingEdits, []);
    assert.equal(freshness.recentChangesError, undefined);
  });

  test("events for sections that were not requested do not leak into them", async () => {
    const { service } = setup({
      snapshots: { SKILLS: [{ Name: "Rust" }] },
      events: [peopleEvent({ headline: "H" }, T(24)), likeEvent("urn:li:activity:1", { capturedAt: T(24) })],
    });
    const skills = await service.getSection({ section: "skills" });
    assert.deepEqual(skills.items, [{ name: "Rust" }]);
    assert.equal(skills.freshness.recentChangesMerged, 0);
  });

  test("very long and unicode text round-trips unchanged through a section", async () => {
    const long = "Ünïcödé 🚀 ".repeat(20_000);
    const { service } = setup({ snapshots: { ALL_COMMENTS: [{ Date: "2026-09-01 10:00:00", Link: "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A1", Message: long }] } });
    const page = await service.getSection({ section: "comments" });
    assert.equal((page.items[0] as { message: string }).message, long);
  });
});
