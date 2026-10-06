import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  buildFeedLink,
  collapseText,
  dedupeRows,
  formatUtc,
  linkPostUrn,
  linkTarget,
  normalizeRow,
  resolveLocalized,
  toCamelKey,
} from "../src/linkedin/normalize.js";

describe("toCamelKey", () => {
  const cases: Array<[string, string | undefined]> = [
    ["First Name", "firstName"],
    ["Date/Time", "dateTime"],
    ["Content Completed At (if completed)", "contentCompletedAtIfCompleted"],
    ["ShareLink", "shareLink"],
    ["inviterProfileUrl", "inviterProfileUrl"],
    ["QUERY_CONTEXT", "queryContext"],
    ["Group name", "groupName"],
    ["", undefined],
    ["  ", undefined],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      assert.equal(toCamelKey(input), expected);
    });
  }
});

describe("normalizeRow", () => {
  test("camelCases keys, drops empty keys and empty values", () => {
    const row = { "First Name": "Ada", "Maiden Name": "", "": "junk", Websites: "  ", Notes: null, Count: 0 };
    assert.deepEqual(normalizeRow(row), { firstName: "Ada", count: 0 });
  });

  test("applies redactions by normalized key", () => {
    const row = { "First Name": "Ada", "Email Address": "ada@example.com" };
    assert.deepEqual(normalizeRow(row, ["emailAddress"]), { firstName: "Ada" });
  });

  test("keeps nested values as-is", () => {
    const row = { savedItem: { url: "https://x" } };
    assert.deepEqual(normalizeRow(row), { savedItem: { url: "https://x" } });
  });
});

describe("dedupeRows", () => {
  test("removes exact duplicates regardless of key order and keeps first-seen order", () => {
    const rows = [{ a: 1, b: 2 }, { c: 3 }, { b: 2, a: 1 }];
    assert.deepEqual(dedupeRows(rows), [{ a: 1, b: 2 }, { c: 3 }]);
  });
});

describe("resolveLocalized", () => {
  test("plain string passes through", () => assert.equal(resolveLocalized("x"), "x"));
  test("localized string", () => assert.equal(resolveLocalized({ localized: { en_US: "Hello" } }), "Hello"));
  test("localized rawText object", () =>
    assert.equal(resolveLocalized({ localized: { en_US: { rawText: "Body" } } }), "Body"));
  test("prefers preferredLocale", () =>
    assert.equal(
      resolveLocalized({
        localized: { de_DE: "Hallo", da_DK: "Hej" },
        preferredLocale: { country: "DK", language: "da" },
      }),
      "Hej",
    ));
  test("falls back to the first value when preferredLocale is not in the map", () =>
    assert.equal(
      resolveLocalized({
        localized: { de_DE: "Hallo", da_DK: "Hej" },
        preferredLocale: { country: "US", language: "en" },
      }),
      "Hallo",
    ));
  test("unknown shapes resolve to undefined", () => {
    assert.equal(resolveLocalized({ foo: 1 }), undefined);
    assert.equal(resolveLocalized(42), undefined);
  });
});

describe("collapseText", () => {
  test("collapses whitespace and case-folds", () => {
    assert.equal(collapseText("  Line one\n\nLine  TWO "), "line one line two");
    assert.equal(collapseText(undefined), "");
  });
});

describe("formatUtc", () => {
  test("formats epoch ms like snapshot dates (UTC)", () => {
    assert.equal(formatUtc(Date.UTC(2026, 9, 2, 7, 5, 9, 450)), "2026-10-02 07:05:09");
  });

  test("gives the UTC reading whatever the machine's time zone is (checked in child processes with a zone set)", () => {
    // 2026-10-02 07:05:09 UTC is 00:05 on Oct 2 in Los Angeles, 12:35 in Kolkata and 21:05 on Oct 2 in Kiritimati (UTC+14):
    // the zones differ from UTC in the hour, the minute and the date, so reading local time instead of UTC cannot pass.
    const script = `
      import { formatUtc } from ${JSON.stringify(new URL("../src/linkedin/normalize.ts", import.meta.url).href)};
      const out = {};
      for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        process.env.TZ = zone;
        out[zone] = [formatUtc(Date.UTC(2026, 9, 2, 7, 5, 9, 450)), formatUtc(Date.UTC(2026, 0, 1, 0, 0, 0))];
      }
      console.log(JSON.stringify(out));
    `;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.equal(r.status, 0, r.stderr);
    const same = ["2026-10-02 07:05:09", "2026-01-01 00:00:00"];
    assert.deepEqual(JSON.parse(r.stdout), {
      UTC: same,
      "America/Los_Angeles": same,
      "Asia/Kolkata": same,
      "Pacific/Kiritimati": same,
    });
  });
});

describe("feed links", () => {
  test("linkTarget reads path URN", () => {
    assert.equal(
      linkTarget("https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7462903540748034050"),
      "urn:li:activity:7462903540748034050",
    );
  });

  test("linkTarget prefers commentUrn param", () => {
    assert.equal(
      linkTarget(
        "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A111111111111?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A111111111111%2C222222222222%29",
      ),
      "urn:li:comment:(activity:111111111111,222222222222)",
    );
  });

  test("linkTarget returns undefined for non-feed links", () => {
    assert.equal(linkTarget("https://www.linkedin.com/in/someone"), undefined);
    assert.equal(linkTarget("not a url"), undefined);
  });

  test("buildFeedLink encodes like the snapshot", () => {
    assert.equal(
      buildFeedLink("urn:li:comment:(activity:111111111111,222222222222)"),
      "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A111111111111?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A111111111111%2C222222222222%29",
    );
    assert.equal(
      buildFeedLink("urn:li:ugcPost:333333333333"),
      "https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A333333333333",
    );
  });

  const forms = [
    "urn:li:activity:7462903540748034050",
    "urn:li:ugcPost:7462903540748034050",
    "urn:li:share:7462903540748034050",
    "urn:li:comment:(activity:111111111111,222222222222)",
    "urn:li:comment:(ugcPost:111111111111,222222222222)",
    "urn:li:article:111111111111",
    "urn:li:comment:(articleSegment:(urn:li:linkedInArticle:111111111111,222222222222),333333333333)",
    "urn:li:groupPost:67926-111111111111",
  ];
  for (const urn of forms) {
    test(`round-trip ${urn}`, () => assert.equal(linkTarget(buildFeedLink(urn)), urn));
  }
});

describe("linkPostUrn", () => {
  test("a comment link's post is the parent in the comment URN, for all four comment forms", () => {
    const cases: [string, string][] = [
      ["urn:li:comment:(activity:111111111111,222222222222)", "urn:li:activity:111111111111"],
      ["urn:li:comment:(urn:li:activity:111111111111,222222222222)", "urn:li:activity:111111111111"],
      ["urn:li:comment:(ugcPost:111111111111,222222222222)", "urn:li:ugcPost:111111111111"],
      [
        "urn:li:comment:(articleSegment:(urn:li:linkedInArticle:111111111111,222222222222),333333333333)",
        "urn:li:articleSegment:(urn:li:linkedInArticle:111111111111,222222222222)",
      ],
    ];
    for (const [comment, post] of cases) {
      assert.equal(linkPostUrn(buildFeedLink(comment)), post, comment);
    }
  });

  test("returns the path URN even when a commentUrn is present", () => {
    assert.equal(
      linkPostUrn(
        "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A111111111111?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A111111111111%2C222222222222%29",
      ),
      "urn:li:activity:111111111111",
    );
    assert.equal(linkPostUrn("https://www.linkedin.com/feed/update/urn:li:share:5/"), "urn:li:share:5");
    assert.equal(linkPostUrn("https://example.com/x"), undefined);
  });

  test("linkTarget tolerates unencoded URNs and trailing slashes", () => {
    assert.equal(linkTarget("https://www.linkedin.com/feed/update/urn:li:share:5/"), "urn:li:share:5");
  });
});

describe("keys that are not plain ASCII", () => {
  test("letters from other scripts survive camelCasing", () => {
    assert.equal(toCamelKey("Prénom du père"), "prénomDuPère");
    assert.equal(toCamelKey("Größe Maß"), "größeMaß");
    assert.equal(toCamelKey("名前"), "名前");
    assert.equal(toCamelKey("Pre\u0301nom"), "pre\u0301nom"); // decomposed é keeps its accent
    assert.equal(toCamelKey("Имя Фамилия"), "имяФамилия");
  });

  test("a key with nothing but symbols or emoji has no usable name", () => {
    assert.equal(toCamelKey("🎉"), undefined);
    assert.equal(toCamelKey("—"), undefined);
    assert.equal(toCamelKey("🎉 Party time"), "partyTime");
  });

  test("unicode and emoji values are kept byte for byte", () => {
    const value = "Zażółć gęślą jaźń 🚀 👩‍💻 \u0000 \u202e end";
    assert.deepEqual(normalizeRow({ "Prénom": value, "名前": "山田" }), { prénom: value, 名前: "山田" });
  });
});

describe("keys that collide after camelCasing", () => {
  test("different values are all kept instead of the last one winning", () => {
    assert.deepEqual(normalizeRow({ "First Name": "Ada", first_name: "Augusta", FIRST_NAME: "Lovelace" }), {
      firstName: "Ada",
      firstName2: "Augusta",
      firstName3: "Lovelace",
    });
  });

  test("identical values collapse, and an empty colliding value never displaces a real one", () => {
    assert.deepEqual(normalizeRow({ "First Name": "Ada", first_name: "Ada" }), { firstName: "Ada" });
    assert.deepEqual(normalizeRow({ "First Name": "", first_name: "Ada" }), { firstName: "Ada" });
    assert.deepEqual(normalizeRow({ "First Name": "Ada", first_name: "" }), { firstName: "Ada" });
  });

  test("a generated suffix never overwrites a real key of that name", () => {
    assert.deepEqual(normalizeRow({ "First Name": "Ada", first_name: "Augusta", firstName2: "Real" }), {
      firstName: "Ada",
      firstName3: "Augusta",
      firstName2: "Real",
    });
  });

  test("a redacted key stays redacted whichever spelling it arrives in", () => {
    assert.deepEqual(normalizeRow({ "Email Address": "a@b.c", email_address: "d@e.f", Name: "x" }, ["emailAddress"]), { name: "x" });
  });

  test("hostile keys become ordinary own properties", () => {
    const row = JSON.parse('{"__proto__": "p", "constructor": "c", "toString": "t"}');
    const result = normalizeRow(row);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.deepEqual(Object.keys(result).sort(), ["constructor", "proto", "toString"]);
  });
});

describe("dedupeRows at scale and with odd values", () => {
  test("deduplication looks at each row about once (linear), not once per other row", () => {
    // Counting getter instead of a wall-clock bound: a pairwise comparison would read it ~n^2/2 times.
    let reads = 0;
    const rows = Array.from({ length: 2000 }, (_, i) => {
      const row: Record<string, unknown> = { nested: { a: [i % 1500, { b: "x" }] } };
      Object.defineProperty(row, "name", { enumerable: true, get: () => (reads++, `n${i % 1500}`) });
      return row;
    });
    assert.equal(dedupeRows(rows).length, 1500);
    assert.ok(reads <= 3 * rows.length, `name was read ${reads} times`);
  });

  test("rows that only differ in nested values or in value type are not merged", () => {
    assert.equal(dedupeRows([{ a: { b: 1 } }, { a: { b: 2 } }, { a: "1" }, { a: 1 }]).length, 4);
  });
});
