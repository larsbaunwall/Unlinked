import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildActivityFeed, cleanChangelog, findPendingEdits, mergeComments, mergeIntro, mergePosts, mergeReactions } from "../src/linkedin/merge.js";
import { buildFeedLink } from "../src/linkedin/normalize.js";
import { commentEvent, event, positionEvent, postEvent, likeEvent, peopleEvent, T } from "./helpers/events.js";

// Literal expectations, written out by hand so they do not depend on the helpers the code uses.
const L_POST = "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A111111111111";
const L_COMMENT = `${L_POST}?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A111111111111%2C222222222222%29`;
const L_UGC = "https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7000000000000000001";
const L_SHARE = "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7000000000000000001";

describe("cleanChangelog", () => {
  test("drops messages and invitations", () => {
    const events = [
      event({ resourceName: "messages", method: "CREATE", activity: { body: "secret" } }),
      event({ resourceName: "invitations", method: "ACTION", methodName: "verifyAndCreate", activity: {} }),
      likeEvent("urn:li:activity:111111111111", { capturedAt: T(20) }),
    ];
    const cleaned = cleanChangelog(events);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0]?.resourceName, "socialActions/likes");
  });

  test("keeps only the activity fields the merge and feed use, per resource", () => {
    const cleaned = cleanChangelog([
      likeEvent("urn:li:activity:111111111111", { capturedAt: T(20) }),
      commentEvent("urn:li:activity:222222222222", "55", "Nice", { capturedAt: T(21) }),
      peopleEvent({ headline: "H", lastModified: 5, headlineTimestamps: { a: 1 }, birthDate: "secret" }, T(22)),
      positionEvent({ description: "D", associatedSkills: ["urn:li:s:1"], company: "urn:li:organization:1" }, T(23)),
      postEvent("urn:li:ugcPost:123", "Hello", { capturedAt: T(24) }),
      event({ resourceName: "somethingElse", method: "CREATE", activity: { secret: 1 } }),
    ]);
    const activities = Object.fromEntries(cleaned.map((e) => [e.resourceName, e.activity]));
    assert.deepEqual(activities["socialActions/likes"], { object: "urn:li:activity:111111111111", reactionType: "LIKE" });
    assert.deepEqual(activities["socialActions/comments"], { id: "55", object: "urn:li:activity:222222222222", message: { text: "Nice" } });
    assert.deepEqual(activities.people, { headline: "H" });
    assert.deepEqual(activities["people/positions"], { description: "D" });
    assert.deepEqual(activities.ugcPosts, {
      id: "urn:li:ugcPost:123",
      specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: "Hello" } } },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    });
    assert.equal(cleaned.some((e) => e.resourceName === "somethingElse"), false);
    assert.doesNotMatch(JSON.stringify(cleaned), /"actor"|owner|secret|lastModified/);
  });

  test("sorts by capturedAt ascending", () => {
    const late = likeEvent("urn:li:activity:333333333333", { capturedAt: T(22) });
    const early = likeEvent("urn:li:activity:444444444444", { capturedAt: T(20) });
    assert.deepEqual(
      cleanChangelog([late, early]).map((e) => e.capturedAt),
      [T(20), T(22)],
    );
  });

  test("unwraps patch.$set and resolves localized values", () => {
    const raw = peopleEvent(
      { patch: { $set: { headline: { localized: { en_US: "Builder" } }, lastModified: 5 } } },
      T(20),
    );
    const [cleaned] = cleanChangelog([raw]);
    assert.equal(cleaned?.activity.headline, "Builder");
  });

  test("resolves localized rawText objects and leaves other values alone", () => {
    const raw = positionEvent(
      { description: { localized: { en_US: { rawText: "Body" } } }, associatedSkills: ["urn:li:profileSkill:1"] },
      T(20),
    );
    const [cleaned] = cleanChangelog([raw]);
    assert.deepEqual(cleaned?.activity, { description: "Body" });
  });

  test("output is plain JSON and only carries the fields merging needs", () => {
    const [cleaned] = cleanChangelog([likeEvent("urn:li:activity:555555555555", { capturedAt: T(20) })]);
    assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), cleaned);
    assert.deepEqual(Object.keys(cleaned!).sort(), [
      "activity",
      "activityId",
      "capturedAt",
      "method",
      "resourceId",
      "resourceName",
      "resourceUri",
    ]);
  });

  test("tolerates garbage input", () => {
    assert.deepEqual(cleanChangelog([null, 5, "x", {}, { resourceName: "people" }]), []);
  });
});

describe("mergeIntro", () => {
  const base = { firstName: "Ada", lastName: "Lovelace", headline: "Old headline", about: "Old about" };

  test("a people headline event overrides the headline", () => {
    const events = cleanChangelog([
      peopleEvent({ headline: { localized: { en_US: "New headline" } }, lastModified: 1 }, T(20)),
    ]);
    const result = mergeIntro(base, events);
    assert.deepEqual(result.intro, { ...base, headline: "New headline" });
    assert.equal(result.applied, 1);
  });

  test("latest event wins; summary maps to about; names apply", () => {
    const events = cleanChangelog([
      peopleEvent({ headline: "Second", summary: "New about" }, T(22)),
      peopleEvent({ headline: "First", firstName: "Augusta" }, T(20)),
    ]);
    const { intro } = mergeIntro(base, events);
    assert.equal(intro?.headline, "Second");
    assert.equal(intro?.about, "New about");
    assert.equal(intro?.firstName, "Augusta");
    assert.equal(intro?.lastName, "Lovelace");
  });

  test("does not count or change anything when values already match", () => {
    const events = cleanChangelog([peopleEvent({ headline: "Old headline" }, T(20))]);
    const result = mergeIntro(base, events);
    assert.deepEqual(result.intro, base);
    assert.equal(result.applied, 0);
  });

  test("ignores other resources, DELETE and unrelated fields", () => {
    const events = cleanChangelog([
      peopleEvent({ lastModified: 3 }, T(20)),
      peopleEvent({ headline: "Gone" }, T(21), "DELETE"),
      likeEvent("urn:li:activity:111111111111", { capturedAt: T(22) }),
    ]);
    const result = mergeIntro(base, events);
    assert.deepEqual(result.intro, base);
    assert.equal(result.applied, 0);
  });

  test("builds an intro when the snapshot had none", () => {
    const events = cleanChangelog([peopleEvent({ headline: "Hello" }, T(20))]);
    assert.deepEqual(mergeIntro(undefined, events).intro, { headline: "Hello" });
    assert.equal(mergeIntro(undefined, []).intro, undefined);
  });

  test("does not mutate its input", () => {
    const input = { ...base };
    mergeIntro(input, cleanChangelog([peopleEvent({ headline: "X" }, T(20))]));
    assert.deepEqual(input, base);
  });
});

describe("mergeReactions", () => {
  const POST = "urn:li:activity:111111111111";
  const COMMENT = "urn:li:comment:(activity:111111111111,222222222222)";
  const row = (urn: string, date: string, type = "LIKE") => ({ date, type, link: buildFeedLink(urn) });
  const merge = (rows: ReturnType<typeof row>[], raw: unknown[]) => mergeReactions(rows, cleanChangelog(raw));

  test("adds a CREATE missing from the snapshot, in snapshot format", () => {
    const at = T(22, 7, 5, 9);
    const { items, applied } = merge([], [likeEvent(POST, { capturedAt: at, reactionType: "PRAISE" })]);
    assert.deepEqual(items, [{ date: "2026-09-22 07:05:09", type: "PRAISE", link: L_POST }]);
    assert.equal(applied, 1);
  });

  test("adds a reaction on a comment with the comment link form", () => {
    const { items } = merge([], [likeEvent(COMMENT, { capturedAt: T(22) })]);
    assert.equal(
      items[0]?.link,
      "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A111111111111?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A111111111111%2C222222222222%29",
    );
  });

  test("does not duplicate a reaction already in the snapshot (post or comment)", () => {
    const rows = [row(POST, "2026-09-20 10:00:00"), row(COMMENT, "2026-09-21 10:00:00")];
    const { items, applied } = merge(rows, [
      likeEvent(POST, { capturedAt: T(20) }),
      likeEvent(COMMENT, { capturedAt: T(21) }),
    ]);
    assert.equal(items.length, 2);
    assert.equal(applied, 0);
  });

  test("a repeated event for the same target is added once", () => {
    const { items } = merge([], [
      likeEvent(POST, { capturedAt: T(20) }),
      likeEvent(POST, { capturedAt: T(21) }),
    ]);
    assert.equal(items.length, 1);
  });

  test("DELETE removes the matching row, using the resourceUri target", () => {
    const rows = [row(POST, "2026-09-20 10:00:00"), row(COMMENT, "2026-09-21 10:00:00")];
    const { items, applied } = merge(rows, [likeEvent(COMMENT, { capturedAt: T(23), method: "DELETE" })]);
    assert.deepEqual(items.map((r) => r.link), [L_POST]);
    assert.equal(applied, 1);
  });

  test("CREATE then DELETE in the window leaves nothing; DELETE then re-CREATE keeps it", () => {
    assert.equal(
      merge([], [
        likeEvent(POST, { capturedAt: T(20) }),
        likeEvent(POST, { capturedAt: T(21), method: "DELETE" }),
      ]).items.length,
      0,
    );
    assert.equal(
      merge([row(POST, "2026-09-01 00:00:00")], [
        likeEvent(POST, { capturedAt: T(21), method: "DELETE" }),
        likeEvent(POST, { capturedAt: T(22) }),
      ]).items.length,
      1,
    );
  });

  test("sorts newest-first by date", () => {
    const rows = [row("urn:li:activity:333333333333", "2026-09-01 00:00:00")];
    const { items } = merge(rows, [likeEvent(POST, { capturedAt: T(22) })]);
    assert.deepEqual(items.map((r) => r.date), ["2026-09-22 10:00:00", "2026-09-01 00:00:00"]);
  });

  test("ignores unrelated events and tolerates missing fields", () => {
    const bad = likeEvent(POST, { capturedAt: T(20) });
    bad.activity = {};
    const { items } = merge([], [bad, peopleEvent({ headline: "x" }, T(21))]);
    assert.deepEqual(items, []);
  });

  test("does not mutate its input", () => {
    const rows = [row(POST, "2026-09-20 10:00:00")];
    const copy = structuredClone(rows);
    merge(rows, [likeEvent(POST, { capturedAt: T(23), method: "DELETE" })]);
    assert.deepEqual(rows, copy);
  });
});

describe("mergeComments", () => {
  const POST = "urn:li:activity:111111111111";
  const merge = (rows: Array<{ date: string; link: string; message: string }>, raw: unknown[]) =>
    mergeComments(rows, cleanChangelog(raw));

  test("adds a CREATE missing from the snapshot, in snapshot format", () => {
    const at = T(22, 8, 30, 0);
    const { items, applied } = merge([], [commentEvent(POST, "222222222222", "Nice work", { capturedAt: at })]);
    assert.deepEqual(items, [
      {
        date: "2026-09-22 08:30:00",
        link: L_POST,
        message: "Nice work",
      },
    ]);
    assert.doesNotMatch(items[0]!.link, /commentUrn/);
    assert.equal(applied, 1);
  });

  test("a merged reply links to the parent post, in the snapshot comment form", () => {
    const reply = commentEvent("urn:li:comment:(activity:111111111111,222222222222)", "444444444444", "Reply", { capturedAt: T(22) });
    const { items } = merge([], [reply]);
    assert.equal(items[0]?.link, L_POST);
    assert.doesNotMatch(items[0]!.link, /commentUrn/);
    const ugc = commentEvent("urn:li:comment:(ugcPost:7000000000000000001,5)", "6", "Reply2", { capturedAt: T(22) });
    assert.equal(merge([], [ugc]).items[0]?.link, L_UGC);
  });

  test("a comment present with different whitespace is not duplicated", () => {
    const rows = [
      { date: "2026-09-20 10:00:00", link: buildFeedLink(POST), message: "Nice   work\nfolks" },
    ];
    const { items, applied } = merge(rows, [commentEvent(POST, "222222222222", "Nice work folks", { capturedAt: T(20) })]);
    assert.equal(items.length, 1);
    assert.equal(applied, 0);
  });

  test("same text on a different post is a different comment", () => {
    const rows = [{ date: "2026-09-20 10:00:00", link: buildFeedLink("urn:li:activity:999999999999"), message: "Nice work" }];
    const { items } = merge(rows, [commentEvent(POST, "222222222222", "Nice work", { capturedAt: T(21) })]);
    assert.equal(items.length, 2);
  });

  test("DELETE removes a comment added in the same window", () => {
    const { items } = merge([], [
      commentEvent(POST, "222222222222", "Oops", { capturedAt: T(20) }),
      commentEvent(POST, "222222222222", "", { capturedAt: T(21), method: "DELETE" }),
    ]);
    assert.deepEqual(items, []);
  });

  test("UPDATE edits a comment added in the same window", () => {
    const { items } = merge([], [
      commentEvent(POST, "222222222222", "Draft", { capturedAt: T(20) }),
      commentEvent(POST, "222222222222", "Final", { capturedAt: T(21), method: "UPDATE" }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.message, "Final");
  });

  test("DELETE and UPDATE of snapshot comments are ignored (no ids to match)", () => {
    const rows = [{ date: "2026-09-20 10:00:00", link: buildFeedLink(POST), message: "Keep me" }];
    const { items, applied } = merge(rows, [
      commentEvent(POST, "222222222222", "", { capturedAt: T(21), method: "DELETE" }),
      commentEvent(POST, "333333333333", "Changed", { capturedAt: T(22), method: "UPDATE" }),
    ]);
    assert.deepEqual(items, rows);
    assert.equal(applied, 0);
  });

  test("replies and malformed events are tolerated", () => {
    const reply = commentEvent("urn:li:comment:(activity:111111111111,222222222222)", "444444444444", "Reply", { capturedAt: T(22) });
    const broken = commentEvent(POST, "555555555555", "x", { capturedAt: T(23) });
    broken.activity = { id: "555555555555" };
    const { items } = merge([], [reply, broken]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.message, "Reply");
  });

  test("sorts newest-first", () => {
    const rows = [{ date: "2026-09-01 00:00:00", link: buildFeedLink("urn:li:activity:999999999999"), message: "Old" }];
    const { items } = merge(rows, [commentEvent(POST, "222222222222", "New", { capturedAt: T(22) })]);
    assert.deepEqual(items.map((r) => r.message), ["New", "Old"]);
  });
});

describe("mergePosts", () => {
  const SHARE = "urn:li:share:7000000000000000001";
  const UGC = "urn:li:ugcPost:7000000000000000001";
  const row = (urn: string, text: string) => ({
    date: "2026-09-10 09:00:00",
    shareLink: buildFeedLink(urn),
    shareCommentary: text,
    visibility: "MEMBER_NETWORK",
  });
  const merge = (rows: ReturnType<typeof row>[], raw: unknown[]) => mergePosts(rows, cleanChangelog(raw));

  test("adds a ugcPost CREATE (docs shape) in snapshot format", () => {
    const at = T(22, 6, 0, 0);
    const { items, applied } = merge([], [postEvent(UGC, "Hello world", { capturedAt: at })]);
    assert.deepEqual(items, [
      { date: "2026-09-22 06:00:00", shareLink: L_UGC, shareCommentary: "Hello world", visibility: "PUBLIC" },
    ]);
    assert.equal(applied, 1);
  });

  test("a post matching by exact URN is not duplicated", () => {
    const { items, applied } = merge([row(UGC, "Hello world")], [postEvent(UGC, "Hello world", { capturedAt: T(20) })]);
    assert.equal(items.length, 1);
    assert.equal(applied, 0);
  });

  test("a post with different URN type but same commentary is not duplicated", () => {
    const { items } = merge([row(SHARE, "Hello   WORLD\n")], [postEvent(UGC, "hello world", { capturedAt: T(20) })]);
    assert.equal(items.length, 1);
  });

  test("urn:li:share resourceIds work and missing fields are tolerated", () => {
    const { items } = merge([], [postEvent(SHARE, undefined, { capturedAt: T(21) })]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.shareLink, L_SHARE);
    assert.equal("shareCommentary" in items[0]!, false);
  });

  test("two different posts without commentary are both kept", () => {
    const { items } = merge([], [
      postEvent(SHARE, undefined, { capturedAt: T(21) }),
      postEvent("urn:li:share:7000000000000000002", undefined, { capturedAt: T(22) }),
    ]);
    assert.equal(items.length, 2);
  });

  test("DELETE removes only on an exact URN match", () => {
    const rows = [row(SHARE, "Keep"), row("urn:li:share:7000000000000000009", "Remove me")];
    const { items, applied } = merge(rows, [
      postEvent("urn:li:share:7000000000000000009", undefined, { capturedAt: T(22), method: "DELETE" }),
      postEvent("urn:li:ugcPost:7000000000000000001", undefined, { capturedAt: T(23), method: "DELETE" }),
    ]);
    assert.deepEqual(items.map((r) => r.shareCommentary), ["Keep"]);
    assert.equal(applied, 1);
  });

  test("ignores events that are not ugcPosts and events without a URN", () => {
    const bad = postEvent(UGC, "x", { capturedAt: T(22) });
    bad.resourceId = "not-a-urn";
    bad.activity = {};
    const { items } = merge([], [bad, peopleEvent({ headline: "x" }, T(21))]);
    assert.deepEqual(items, []);
  });

  test("sorts newest-first", () => {
    const { items } = merge([row(SHARE, "Old")], [postEvent(UGC.replace("1", "2"), "New", { capturedAt: T(22) })]);
    assert.deepEqual(items.map((r) => r.shareCommentary), ["New", "Old"]);
  });
});

describe("findPendingEdits", () => {
  const rows = { experience: [{ title: "Engineer", description: "Built things\nand more things" }] };
  const check = (raw: unknown[], sections: Record<string, Array<Record<string, unknown>>> = rows) =>
    findPendingEdits(cleanChangelog(raw), sections);

  test("flags a section when the edited text is in no row", () => {
    const events = [positionEvent({ description: { localized: { en_US: { rawText: "Brand new text" } } } }, T(20))];
    assert.deepEqual(check(events), ["experience"]);
  });

  test("does not flag when the text is present after whitespace and case folding", () => {
    const events = [
      positionEvent({ description: { localized: { en_US: { rawText: "BUILT THINGS  and more\nthings" } } } }, T(20)),
    ];
    assert.deepEqual(check(events), []);
  });

  test("ignores edits without a text value (e.g. skills only)", () => {
    const events = [positionEvent({ associatedSkills: ["urn:li:profileSkill:1"] }, T(20))];
    assert.deepEqual(check(events), []);
  });

  test("only the latest edit of a resource counts", () => {
    const events = [
      positionEvent({ description: "Superseded text" }, T(20), "9001"),
      positionEvent({ description: "Built things and more things" }, T(21), "9001"),
    ];
    assert.deepEqual(check(events), []);
  });

  test("does not report sections that were not fetched, and never lists intro or activity events", () => {
    const events = [
      positionEvent({ description: "Something" }, T(20)),
      peopleEvent({ headline: "x" }, T(21)),
      likeEvent("urn:li:activity:111111111111", { capturedAt: T(22) }),
    ];
    assert.deepEqual(check(events, { skills: [] }), []);
  });

  test("a new position (CREATE) missing from the snapshot is pending; DELETE is not", () => {
    const created = [positionEvent({ title: "Brand New Role" }, T(20), "9002", "CREATE")];
    assert.deepEqual(check(created), ["experience"]);
    const deleted = [positionEvent({ title: "Brand New Role" }, T(20), "9002", "DELETE")];
    assert.deepEqual(check(deleted), []);
  });
});

describe("buildActivityFeed", () => {
  const feed = (raw: unknown[]) => buildActivityFeed(cleanChangelog(raw));
  const POST = "urn:li:activity:111111111111";

  test("newest first, ISO timestamps, no raw fields", () => {
    const items = feed([
      peopleEvent({ headline: "Hi" }, T(20, 10)),
      likeEvent(POST, { capturedAt: T(22, 10), reactionType: "PRAISE" }),
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.at, "2026-09-22T10:00:00.000Z");
    assert.equal(items[0]?.section, "reactions");
    assert.deepEqual(Object.keys(items[0]!).sort(), ["at", "change", "section", "summary"]);
  });

  test("intro changes", () => {
    const [headline, about] = feed([
      peopleEvent({ headline: "Hi" }, T(20)),
      peopleEvent({ summary: "About me" }, T(21)),
    ]).reverse();
    assert.deepEqual(headline, { at: new Date(T(20)).toISOString(), section: "intro", change: "edited", summary: "Headline updated" });
    assert.equal(about?.summary, "About updated");
  });

  test("profile collection edits", () => {
    const [item] = feed([positionEvent({ description: "x" }, T(20))]);
    assert.equal(item?.section, "experience");
    assert.equal(item?.change, "edited");
    assert.equal(item?.summary, "Position description edited");
    const [added] = feed([positionEvent({ title: "Role" }, T(20), "9002", "CREATE")]);
    assert.equal(added?.change, "added");
    assert.equal(added?.summary, "Position added");
    const [removed] = feed([positionEvent({}, T(20), "9002", "DELETE")]);
    assert.equal(removed?.change, "removed");
  });

  test("reactions carry type and link; comments carry text and link; posts carry text and link", () => {
    const items = feed([
      likeEvent(POST, { capturedAt: T(20), reactionType: "PRAISE" }),
      commentEvent(POST, "222222222222", "Great", { capturedAt: T(21) }),
      postEvent("urn:li:ugcPost:7000000000000000001", "My post", { capturedAt: T(22) }),
    ]).reverse();
    assert.equal(items[0]?.summary, `PRAISE ${L_POST}`);
    assert.equal(items[0]?.change, "added");
    assert.equal(items[1]?.summary, `Great ${L_COMMENT}`);
    assert.equal(items[2]?.summary, `My post ${L_UGC}`);
  });

  test("removals and edits of activity items", () => {
    const [del] = feed([likeEvent(POST, { capturedAt: T(20), method: "DELETE" })]);
    assert.equal(del?.change, "removed");
    assert.equal(del?.summary, `Reaction removed ${L_POST}`);
    const [upd] = feed([commentEvent(POST, "222222222222", "Edited", { capturedAt: T(20), method: "UPDATE" })]);
    assert.equal(upd?.change, "edited");
  });

  test("excludes invitations, messages and unknown resources", () => {
    assert.deepEqual(
      feed([
        event({ resourceName: "messages", method: "CREATE" }),
        event({ resourceName: "invitations", method: "ACTION", methodName: "verifyAndCreate" }),
        event({ resourceName: "somethingNew", method: "CREATE" }),
        peopleEvent({ lastModified: 1 }, T(20)),
      ]),
      [],
    );
  });
});

describe("defaults, labels and guards that earlier tests did not pin", () => {
  const POST_URN = "urn:li:activity:111111111111";
  const noType = (method = "CREATE") =>
    event({
      resourceName: "socialActions/likes",
      method,
      capturedAt: T(22, 10),
      resourceUri: `/socialActions/${POST_URN}/likes/urn:li:person:SyntheticMember1`,
      activity: { object: POST_URN },
    });

  test("a reaction event without reactionType is a LIKE, in the merge and in the feed", () => {
    const events = cleanChangelog([noType()]);
    const { items } = mergeReactions([], events);
    assert.deepEqual(items, [{ date: "2026-09-22 10:00:00", type: "LIKE", link: L_POST }]);
    assert.equal(buildActivityFeed(events)[0]?.summary, `LIKE ${L_POST}`);
  });

  test("the intro takes firstName and lastName from people events", () => {
    const events = cleanChangelog([peopleEvent({ firstName: "Grace", lastName: "Hopper" }, T(22))]);
    const merged = mergeIntro({ firstName: "Ada", lastName: "Lovelace", headline: "H" }, events);
    assert.deepEqual(merged.intro, { firstName: "Grace", lastName: "Hopper", headline: "H" });
    assert.equal(merged.applied, 2);
    assert.deepEqual(mergeIntro(undefined, cleanChangelog([peopleEvent({ lastName: "Hopper" }, T(22))])).intro, { lastName: "Hopper" });
  });

  test("a comment on a reply keeps the parent comment URN in the feed link", () => {
    const reply = "urn:li:comment:(activity:111111111111,222222222222)";
    const feed = buildActivityFeed(cleanChangelog([commentEvent(reply, "333333333333", "a reply", { capturedAt: T(22) })]));
    assert.deepEqual(feed.map((i) => [i.section, i.change, i.summary]), [["comments", "added", `a reply ${L_COMMENT}`]]);
  });

  test("feed labels: Name updated, Comment removed, Post removed and the Organization noun", () => {
    const feed = (events: unknown[]) => buildActivityFeed(cleanChangelog(events)).map((i) => [i.section, i.change, i.summary]);
    assert.deepEqual(feed([peopleEvent({ firstName: "Grace" }, T(22))]), [["intro", "edited", "Name updated"]]);
    assert.deepEqual(feed([peopleEvent({ lastName: "Hopper" }, T(22))]), [["intro", "edited", "Name updated"]]);
    assert.deepEqual(feed([commentEvent(POST_URN, "222222222222", "x", { capturedAt: T(22), method: "DELETE" })]), [
      ["comments", "removed", `Comment removed ${L_COMMENT}`],
    ]);
    assert.deepEqual(feed([postEvent("urn:li:ugcPost:7000000000000000001", undefined, { capturedAt: T(22), method: "DELETE" })]), [
      ["posts", "removed", `Post removed ${L_UGC}`],
    ]);
    assert.deepEqual(
      feed([event({ resourceName: "people/organizations", method: "PARTIAL_UPDATE", capturedAt: T(22), activity: { name: "Acme" } })]),
      [["organizations", "edited", "Organization name edited"]],
    );
    assert.deepEqual(
      feed([event({ resourceName: "people/organizations", method: "CREATE", capturedAt: T(22), activity: {} })]),
      [["organizations", "added", "Organization added"]],
    );
  });

  test("a post with an empty visibility value gets no visibility field", () => {
    const events = cleanChangelog([postEvent("urn:li:ugcPost:7000000000000000001", "Hello", { capturedAt: T(22), visibility: "" })]);
    assert.deepEqual(events[0]!.activity, {
      id: "urn:li:ugcPost:7000000000000000001",
      specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: "Hello" } } },
    });
    assert.deepEqual(mergePosts([], events).items, [{ date: "2026-09-22 10:00:00", shareLink: L_UGC, shareCommentary: "Hello" }]);
  });

  test("an edit that differs from a snapshot text only in whitespace is not pending", () => {
    const rows = { experience: [{ title: "Eng", description: "Led the team" }] };
    const edit = (description: string) => cleanChangelog([positionEvent({ description }, T(22))]);
    assert.deepEqual(findPendingEdits(edit("Led theteam"), rows), []);
    assert.deepEqual(findPendingEdits(edit("Led the \n team"), rows), []);
    assert.deepEqual(findPendingEdits(edit("Led the squad"), rows), ["experience"]);
  });

  test("a comment UPDATE with the text it already has is not counted as applied", () => {
    const events = cleanChangelog([
      commentEvent(POST_URN, "222222222222", "same", { capturedAt: T(21) }),
      commentEvent(POST_URN, "222222222222", "same", { capturedAt: T(22), method: "UPDATE" }),
    ]);
    const merged = mergeComments([], events);
    assert.equal(merged.applied, 1);
    assert.deepEqual(merged.items.map((i) => i.message), ["same"]);
  });
});

describe("every people/<collection> resource feeds its own section", () => {
  // Written out by hand: LinkedIn resource name, the section it feeds, and the noun used in the activity feed.
  const collections: Array<[string, string, string]> = [
    ["positions", "experience", "Position"],
    ["educations", "education", "Education"],
    ["skills", "skills", "Skill"],
    ["certifications", "certifications", "Certification"],
    ["projects", "projects", "Project"],
    ["languages", "languages", "Language"],
    ["honors", "honors", "Honor"],
    ["courses", "courses", "Course"],
    ["publications", "publications", "Publication"],
    ["patents", "patents", "Patent"],
    ["volunteerExperiences", "volunteering", "Volunteering entry"],
    ["organizations", "organizations", "Organization"],
  ];

  for (const [collection, section, noun] of collections) {
    test(`people/${collection} -> ${section}, "${noun}"`, () => {
      const edit = event({ resourceName: `people/${collection}`, method: "PARTIAL_UPDATE", capturedAt: T(20), resourceId: "9001", activity: { description: "Brand new text" } });
      const events = cleanChangelog([edit]);
      assert.equal(events.length, 1);
      // A row that does not contain the new text: the edit is pending in exactly this section.
      assert.deepEqual(findPendingEdits(events, { [section]: [{ description: "Old text" }] }), [section]);
      assert.deepEqual(buildActivityFeed(events), [
        { at: "2026-09-20T10:00:00.000Z", section, change: "edited", summary: `${noun} description edited` },
      ]);
      const created = cleanChangelog([event({ resourceName: `people/${collection}`, method: "CREATE", capturedAt: T(20), resourceId: "9002", activity: {} })]);
      assert.deepEqual(buildActivityFeed(created), [{ at: "2026-09-20T10:00:00.000Z", section, change: "added", summary: `${noun} added` }]);
    });
  }

  test("a people/<something else> resource feeds nothing", () => {
    const other = cleanChangelog([event({ resourceName: "people/phoneNumbers", method: "PARTIAL_UPDATE", capturedAt: T(20), activity: { description: "x" } })]);
    assert.deepEqual(other, []);
  });
});

describe("each text field of a profile edit counts as an edit", () => {
  // The text fields the pending-edit check and the feed read, and the entry that proves each one.
  const fields = ["description", "title", "name", "summary", "text", "degreeName", "schoolName", "companyName", "notes"];
  for (const field of fields) {
    test(`${field}: a new value that no row shows is pending, and the feed says "${field} edited"`, () => {
      const events = cleanChangelog([positionEvent({ [field]: "A value no row has" }, T(20))]);
      assert.deepEqual(findPendingEdits(events, { experience: [{ title: "Engineer" }] }), ["experience"]);
      assert.equal(buildActivityFeed(events)[0]?.summary, `Position ${field} edited`);
    });
  }

  test("an education degreeName edit missing from the snapshot: pending education, 'Education degreeName edited'", () => {
    const events = cleanChangelog([event({ resourceName: "people/educations", method: "PARTIAL_UPDATE", capturedAt: T(20), resourceId: "7", activity: { degreeName: "MSc Computer Science" } })]);
    assert.deepEqual(findPendingEdits(events, { education: [{ schoolName: "Synthetic University" }] }), ["education"]);
    assert.equal(buildActivityFeed(events)[0]?.summary, "Education degreeName edited");
  });

  test("an experience companyName edit missing from the snapshot: pending experience, 'Position companyName edited'", () => {
    const events = cleanChangelog([positionEvent({ companyName: "Brand New Co" }, T(20))]);
    assert.deepEqual(findPendingEdits(events, { experience: [{ companyName: "Acme" }] }), ["experience"]);
    assert.equal(buildActivityFeed(events)[0]?.summary, "Position companyName edited");
  });

  test("the same edit is not pending once a row shows the value", () => {
    const events = cleanChangelog([positionEvent({ companyName: "Brand New Co" }, T(20))]);
    assert.deepEqual(findPendingEdits(events, { experience: [{ companyName: "Brand New Co" }] }), []);
  });
});

describe("merge details that the first tests did not pin", () => {
  const POST = "urn:li:activity:111111111111";
  const UGC = "urn:li:ugcPost:7000000000000000001";

  test("a post with the same URN but edited text is not duplicated", () => {
    const rows = [{ date: "2026-09-10 09:00:00", shareLink: buildFeedLink(UGC), shareCommentary: "Original text", visibility: "PUBLIC" }];
    const { items, applied } = mergePosts(rows, cleanChangelog([postEvent(UGC, "Completely different edited text", { capturedAt: T(20) })]));
    assert.deepEqual(items, rows);
    assert.equal(applied, 0);
  });

  test("a comment PARTIAL_UPDATE edits the comment this merge added", () => {
    const { items, applied } = mergeComments([], cleanChangelog([
      commentEvent(POST, "222222222222", "Draft", { capturedAt: T(20) }),
      commentEvent(POST, "222222222222", "Final words", { capturedAt: T(21), method: "PARTIAL_UPDATE" }),
    ]));
    assert.deepEqual(items.map((i) => i.message), ["Final words"]);
    assert.equal(applied, 2);
  });

  test("rows with the same date keep the snapshot order", () => {
    const row = (n: number, date: string) => ({ date, type: "LIKE", link: buildFeedLink(`urn:li:activity:${100000000000 + n}`) });
    const rows = [row(1, "2026-09-10 10:00:00"), row(2, "2026-09-10 10:00:00"), row(3, "2026-09-12 10:00:00"), row(4, "2026-09-10 10:00:00")];
    const { items } = mergeReactions(rows, []);
    assert.deepEqual(
      items.map((i) => i.link.slice(-12)),
      ["100000000003", "100000000001", "100000000002", "100000000004"],
    );
  });

  test("capturedAt at the edge of the Date range: 8.64e15 is kept, one more or less than -8.64e15 is dropped", () => {
    const at = (capturedAt: number) => cleanChangelog([likeEvent(POST, { capturedAt })]).length;
    assert.equal(at(8.64e15), 1);
    assert.equal(at(8.64e15 + 1), 0);
    assert.equal(at(-8.64e15), 1);
    assert.equal(at(-8.64e15 - 1), 0);
  });
});
