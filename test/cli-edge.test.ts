import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { commentEvent, likeEvent } from "./helpers/events.js";
import { TOKEN, run } from "./helpers/run-cli.js";
import { tempDir } from "./helpers/temp-dir.js";

const snapshots = {
  PROFILE: [{ "First Name": "Ada", Headline: "Builder" }],
  SKILLS: [{ Name: "TypeScript" }, { Name: "Rust" }],
  LANGUAGES: [{ Name: "English" }],
  ALL_LIKES: Array.from({ length: 30 }, (_, i) => ({
    Date: `2026-09-${String(10 + (i % 15)).padStart(2, "0")} 10:00:${String(i).padStart(2, "0")}`,
    Type: "LIKE",
    Link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + i}`,
  })),
};

describe("argument parsing", () => {
  test("the old --stdio flag is a usage error that points at --mcp", async () => {
    const r = await run(["--stdio"]);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, "");
    assert.match(r.errorJson().error, /--mcp/);
    assert.equal(r.fake.urls.length, 0);
  });

  test("--limit accepts only plain positive integers", async () => {
    for (const limit of ["1e3", "0x10", " 5", "5 ", "-1", "1.5", "", "abc", "0", "+5", "٣"]) {
      const r = await run(["section", "skills", "--limit", limit, "--no-cache"], { fake: { snapshots } });
      assert.equal(r.code, 2, JSON.stringify(limit));
      assert.equal(r.stdout, "", JSON.stringify(limit));
    }
    const ok = await run(["section", "skills", "--limit", "007", "--no-cache"], { fake: { snapshots } });
    assert.equal(ok.code, 0);
    const huge = await run(["section", "skills", "--limit", "99999999999999999999", "--no-cache"], { fake: { snapshots } });
    assert.equal(huge.code, 0);
    assert.equal(huge.json().items.length, 2);
    assert.equal(huge.json().nextCursor, undefined);
  });

  test("--sections: duplicates and case are folded; empty entries are skipped", async () => {
    const r = await run(["profile", "--sections", "Skills,,LANGUAGES, skills", "--no-cache"], { fake: { snapshots } });
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json()), ["skills", "languages", "related", "freshness"]);
  });

  test("--sections honors,honors lists the empty section once", async () => {
    const r = await run(["profile", "--sections", "honors,honors", "--no-cache"], { fake: { snapshots } });
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json()), ["honors", "related", "freshness"]);
    assert.deepEqual(r.json().honors, []);
    assert.deepEqual(r.json().freshness.empty, ["honors"]);
    assert.deepEqual(r.fake.domains(), ["HONORS"]);
  });

  test("--sections with nothing in it is a usage error instead of silently using the defaults", async () => {
    for (const value of ["", ",", " , "]) {
      const r = await run(["profile", "--sections", value, "--no-cache"], { fake: { snapshots } });
      assert.equal(r.code, 2, JSON.stringify(value));
      assert.equal(r.fake.urls.length, 0);
    }
  });

  test("--all together with --sections is a usage error", async () => {
    const r = await run(["profile", "--all", "--sections", "skills"], { fake: { snapshots } });
    assert.equal(r.code, 2);
    assert.match(r.errorJson().error, /--all/);
    assert.equal(r.fake.urls.length, 0);
  });

  test("--all-items is not capped: a section with 1,201 rows comes back whole, with no cursor", async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({
      Date: `2026-09-${String(1 + (i % 28)).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}:00`,
      Type: "LIKE",
      Link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + i}`,
    }));
    const r = await run(["section", "reactions", "--all-items", "--no-cache", "--compact"], { fake: { snapshots: { ALL_LIKES: rows } } });
    assert.equal(r.code, 0, r.stderr);
    const page = r.json();
    assert.equal(page.items.length, 1201);
    assert.equal(page.total, 1201);
    assert.equal("nextCursor" in page, false);
    assert.equal(new Set(page.items.map((item: { link: string }) => item.link)).size, 1201);
  });

  test("--all-items cannot be combined with a real, valid --cursor either", async () => {
    const cacheDir = await tempDir();
    const first = await run(["section", "reactions", "--limit", "5"], { cacheDir, fake: { snapshots } });
    const cursor = first.json().nextCursor as string;
    assert.ok(cursor);
    const r = await run(["section", "reactions", "--all-items", "--cursor", cursor], { cacheDir, fake: { snapshots } });
    assert.equal(r.code, 2);
    assert.match(r.errorJson().error, /--all-items cannot be combined/);
    assert.equal(r.fake.urls.length, 0);
  });

  test("flags may come before or after the section id, and --compact stays one line", async () => {
    const before = await run(["section", "--compact", "--no-cache", "skills"], { fake: { snapshots } });
    const after = await run(["section", "skills", "--compact", "--no-cache"], { fake: { snapshots } });
    assert.equal(before.code, 0);
    assert.equal(after.code, 0);
    assert.deepEqual({ ...before.json(), freshness: undefined }, { ...after.json(), freshness: undefined });
    assert.equal(before.json().items.length, 2);
    assert.equal(before.stdout.trim().split("\n").length, 1);
    assert.equal(after.stdout.trim().split("\n").length, 1);
  });

  test("section ids are case-insensitive, but LinkedIn's own names are not sections", async () => {
    assert.equal((await run(["section", "SKILLS", "--no-cache"], { fake: { snapshots } })).code, 0);
    const r = await run(["section", "POSITIONS"], { fake: { snapshots } });
    assert.equal(r.code, 2);
    assert.match(r.errorJson().error, /Unknown section/);
  });

  test("an empty section id is a usage error", async () => {
    assert.equal((await run(["section", ""], { fake: { snapshots } })).code, 2);
  });

  test("-- ends option parsing: what follows is positional", async () => {
    assert.equal((await run(["--", "status"], { fake: { authorizations: [] } })).code, 0);
    const r = await run(["profile", "--", "--all"], { fake: { snapshots } });
    assert.equal(r.code, 2);
    assert.match(r.errorJson().error, /Unexpected argument "--all"/);
  });

  test("--help wins over other arguments, even broken ones, and needs no token", async () => {
    for (const argv of [["section", "nonsense", "--help"], ["--help", "--version"], ["--limit", "abc", "--help"], ["--version", "--help"]]) {
      const r = await run(argv, { env: {} });
      assert.equal(r.code, 0, JSON.stringify(argv));
      assert.match(r.stdout, /Usage/);
    }
  });

  test("trailing arguments on status, activity and profile are usage errors", async () => {
    for (const argv of [["status", "extra"], ["activity", "extra"], ["profile", "extra"], ["cache", "clear", "extra"]]) {
      const r = await run(argv, { fake: { snapshots } });
      assert.equal(r.code, 2, JSON.stringify(argv));
      assert.equal(r.stdout, "");
    }
  });

  test("an option that needs a value and gets none is a usage error", async () => {
    for (const argv of [["section", "skills", "--limit"], ["activity", "--since"], ["profile", "--sections"]]) {
      assert.equal((await run(argv, { fake: { snapshots } })).code, 2, JSON.stringify(argv));
    }
  });
});

describe("usage errors never depend on the token", () => {
  // Every case is a usage error on its own; with no token at all it must still be exit 2 (not "Missing token", exit 1).
  const cases: Array<[string[], RegExp]> = [
    [["section", "skills", "--limit", "0"], /--limit must be a whole number/],
    [["activity", "--limit", "abc"], /--limit must be a whole number/],
    [["activity", "--since", "banana"], /Invalid since value/],
    [["section", "skills", "--cursor", "garbage"], /Invalid cursor/],
    [["activity", "--cursor", "garbage"], /Invalid cursor/],
    [["section", "skills", "--sections", "skills"], /does not apply/],
    [["profile", "--limit", "5"], /does not apply/],
    [["profile", "--all", "--sections", "skills"], /--all cannot be combined/],
    [["profile", "--sections", ","], /needs at least one section/],
    [["profile", "--sections", "reactions"], /can be large/],
    [["section", "skills", "--all-items", "--limit", "5"], /--all-items cannot be combined/],
    [["section", "skills", "--all-items", "--cursor", "x"], /--all-items cannot be combined/],
    [["section", "skills", "extra"], /Usage: unlinked section/],
    [["profile", "extra"], /Unexpected argument/],
    [["frobnicate"], /Unknown command/],
    [["cache"], /Usage: unlinked cache clear/],
  ];
  for (const [argv, message] of cases) {
    test(argv.join(" "), async () => {
      const r = await run(argv, { env: {}, fake: { snapshots } });
      assert.equal(r.code, 2);
      assert.equal(r.stdout, "");
      assert.match(r.errorJson().error, message);
      assert.equal(r.fake.urls.length, 0);
    });
  }

  test("a valid cursor for the wrong scope is also a usage error without a token", async () => {
    const cacheDir = await tempDir();
    const first = await run(["section", "reactions", "--limit", "5"], { cacheDir, fake: { snapshots } });
    const r = await run(["section", "skills", "--cursor", first.json().nextCursor], { env: {}, fake: { snapshots } });
    assert.equal(r.code, 2);
    assert.match(r.errorJson().error, /different request/);
  });
});

describe("options that do not apply to a command", () => {
  test("are usage errors instead of being silently ignored", async () => {
    const cases: string[][] = [
      ["profile", "--limit", "5"],
      ["profile", "--cursor", "x"],
      ["profile", "--since", "7d"],
      ["profile", "--all-items"],
      ["section", "skills", "--sections", "skills"],
      ["section", "skills", "--all"],
      ["section", "skills", "--since", "7d"],
      ["activity", "--sections", "skills"],
      ["activity", "--all-items"],
      ["status", "--limit", "5"],
      ["status", "--all"],
      ["status", "--since", "5"],
      ["cache", "clear", "--limit", "5"],
    ];
    for (const argv of cases) {
      const r = await run(argv, { fake: { snapshots } });
      assert.equal(r.code, 2, argv.join(" "));
      assert.equal(r.stdout, "", argv.join(" "));
      assert.match(r.errorJson().error, /does not apply/, argv.join(" "));
      assert.equal(r.fake.urls.length, 0, argv.join(" "));
    }
  });

  test("status --since 5 names the option and the command", async () => {
    const r = await run(["status", "--since", "5"], { fake: { snapshots } });
    assert.equal(r.code, 2);
    assert.equal(r.errorJson().error, '--since does not apply to "status".');
  });

  test("the global flags work on every command", async () => {
    for (const argv of [["profile"], ["section", "skills"], ["activity"], ["status"]]) {
      const r = await run([...argv, "--compact", "--refresh", "--no-cache"], { fake: { snapshots } });
      assert.equal(r.code, 0, argv.join(" "));
      assert.equal(r.stdout.trim().split("\n").length, 1, argv.join(" "));
    }
  });
});

describe("--since", () => {
  const DAY = 86_400_000;
  const events = [
    likeEvent("urn:li:activity:111111111111", { capturedAt: Date.now() - 2 * DAY }),
    commentEvent("urn:li:activity:222222222222", "5", "hi", { capturedAt: Date.now() - 20 * DAY }),
  ];
  const total = async (since: string) => {
    const r = await run(["activity", "--since", since, "--no-cache"], { fake: { events } });
    return { code: r.code, stdout: r.stdout, total: r.code === 0 ? r.json().total : undefined, err: r.code === 0 ? undefined : r.errorJson().error };
  };

  test("accepted forms", async () => {
    assert.equal((await total("1w")).total, 1);
    assert.equal((await total("28d")).total, 2);
    assert.equal((await total("3d")).total, 1);
    assert.equal((await total("0d")).total, 0);
    assert.equal((await total("2020-01-01")).total, 2);
    assert.equal((await total("2999-01-01")).total, 0);
    assert.equal((await total(new Date(Date.now() - 5 * DAY).toISOString().replace("Z", "+00:00"))).total, 1);
    assert.equal((await total(String(Date.now() - 5 * DAY))).total, 1);
    assert.equal((await total("")).total, 2);
    assert.equal((await total("   ")).total, 2);
  });

  test("everything else is a usage error with nothing on stdout", async () => {
    for (const since of ["0", "-1", "7", "7x", "d", "1.5d", "tomorrow", "2026-13-01", "2026-02-30", "99999999999999999999", "99999999999999999d", "1790000000"]) {
      const r = await total(since);
      assert.equal(r.code, 2, since);
      assert.equal(r.stdout, "", since);
    }
  });

  test("epoch seconds are recognised and the error says to use milliseconds", async () => {
    assert.match((await total("1790000000")).err!, /epoch seconds/);
  });
});

describe("token handling", () => {
  test("a Bearer-prefixed, whitespace-padded token is sent exactly once as Authorization", async () => {
    const r = await run(["status"], { env: { LINKEDIN_TOKEN: `  bearer   ${TOKEN}\n` }, fake: { authorizations: [] } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.fake.authorizations, [`Bearer ${TOKEN}`]);
  });

  test("a whitespace-only token is a missing token (exit 1, no request)", async () => {
    const r = await run(["status"], { env: { LINKEDIN_TOKEN: " \n\t" } });
    assert.equal(r.code, 1);
    assert.match(r.errorJson().error, /Missing LinkedIn token/);
    assert.equal(r.fake.urls.length, 0);
  });

  test("a token with a line break in the middle fails before any request and is not echoed", async () => {
    const r = await run(["status"], { env: { LINKEDIN_TOKEN: "abc-secret\ndef-secret" } });
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes("abc-secret") && !r.stderr.includes("def-secret"));
    assert.equal(r.fake.urls.length, 0);
  });

  test("a LinkedIn error that echoes the token is scrubbed on stderr, and stdout stays empty", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: `bad token ${TOKEN}` }), { status: 401 })) as typeof fetch;
    const r = await run(["profile", "--no-cache"], { fetchImpl });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.errorJson().status, 401);
    assert.ok(!r.stderr.includes(TOKEN), r.stderr);
  });
});
