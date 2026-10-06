import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { T } from "./helpers/events.js";
import { TOKEN, run as baseRun, type RunOptions } from "./helpers/run-cli.js";
import { tempDir } from "./helpers/temp-dir.js";

const snapshots = {
  PROFILE: [{ "First Name": "Ada", Headline: "Builder", Summary: "About me", "Birth Date": "Jan 1" }],
  POSITIONS: [{ "Company Name": "Acme", Title: "Engineer" }],
  SKILLS: [{ Name: "TypeScript" }, { Name: "Rust" }],
  LANGUAGES: [{ Name: "English" }],
  ALL_LIKES: Array.from({ length: 120 }, (_, i) => ({
    Date: `2026-09-${String(10 + (i % 15)).padStart(2, "0")} 10:00:${String(i % 60).padStart(2, "0")}`,
    Type: "LIKE",
    Link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + i}`,
  })),
};

const run = (argv: string[], options: RunOptions = {}) => baseRun(argv, { fake: { snapshots }, ...options });

describe("commands", () => {
  test("profile prints pretty JSON on stdout only", async () => {
    const r = await run(["profile", "--no-cache"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    const profile = r.json();
    assert.equal(profile.intro.headline, "Builder");
    assert.equal(profile.intro.birthDate, undefined);
    assert.deepEqual(profile.related.slice(0, 3), [
      { section: "endorsements-given", label: "Endorsements you gave" },
      { section: "posts", label: "Activity > Posts" },
      { section: "comments", label: "Activity > Comments" },
    ]);
    assert.match(profile.freshness.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(r.stdout, /\n {2}"intro"/);
    assert.ok(r.stdout.endsWith("\n"));
  });

  test("--compact prints one line", async () => {
    const r = await run(["profile", "--compact", "--no-cache"]);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const profile = r.json();
    assert.deepEqual(Object.keys(profile), ["intro", "experience", "education", "skills", "certifications", "projects", "related", "freshness"]);
    assert.equal(profile.intro.headline, "Builder");
    assert.deepEqual(profile.skills, [{ name: "TypeScript" }, { name: "Rust" }]);
  });

  test("profile --sections and --all", async () => {
    const some = await run(["profile", "--sections", "languages,skills", "--no-cache"]);
    assert.deepEqual(Object.keys(some.json()), ["languages", "skills", "related", "freshness"]);
    const all = await run(["profile", "--all", "--no-cache"]);
    assert.deepEqual(Object.keys(all.json()), [
      "intro", "experience", "education", "skills", "certifications", "projects", "languages", "volunteering", "honors",
      "courses", "publications", "patents", "testScores", "organizations", "causes", "recommendations", "services",
      "related", "freshness",
    ]);
  });

  test("section pages with --limit and --cursor, and --all-items returns everything", async () => {
    const cacheDir = await tempDir();
    const first = await run(["section", "reactions", "--limit", "50"], { cacheDir });
    const page = first.json();
    assert.equal(page.items.length, 50);
    assert.equal(page.total, 120);
    assert.equal(typeof page.nextCursor, "string");
    const a = (await run(["section", "reactions", "--limit", "100"], { cacheDir })).json();
    const b = (await run(["section", "reactions", "--cursor", a.nextCursor], { cacheDir })).json();
    assert.equal(b.items.length, 20);
    assert.equal(b.nextCursor, undefined);

    const everything = (await run(["section", "reactions", "--all-items", "--no-cache"])).json();
    assert.equal(everything.items.length, 120);
    assert.equal(everything.nextCursor, undefined);
  });

  test("status reports whether changelog tracking is on", async () => {
    const r = await run(["status"], { fake: { authorizations: [{ regulatedAt: T(10), memberComplianceScopes: ["DMA"], memberComplianceAuthorizationKey: { developerApplication: "urn:li:developerApplication:1", member: "urn:li:person:abc" } }] } });
    assert.deepEqual(r.json(), { connected: true, trackingChangesSince: new Date(T(10)).toISOString() });
  });

  test("--help prints the usage lines, flags and exit codes to stdout and exits 0 without a token", async () => {
    const help = await run(["--help"], { env: {} });
    assert.equal(help.code, 0);
    assert.equal(help.stderr, "");
    assert.equal(help.fake.urls.length, 0);
    assert.ok(
      help.stdout.includes(
        "Usage:\n" +
          "  unlinked profile [--sections intro,skills] [--all]\n" +
          "  unlinked section <id> [--limit N] [--cursor C] [--all-items]\n" +
          "  unlinked activity [--since 7d|<ISO date>|<epoch ms>] [--limit N] [--cursor C]\n" +
          "  unlinked status\n" +
          "  unlinked cache clear\n" +
          "  unlinked --mcp                 Run as an MCP server over stdio (the transport)\n",
      ),
      help.stdout,
    );
    assert.ok(
      help.stdout.includes(
        "Flags:\n" +
          "  --refresh     Ignore the local cache and fetch fresh data from LinkedIn\n" +
          "  --no-cache    Do not read or write the local cache\n" +
          "  --compact     Print one-line JSON\n" +
          "  --help        Show this help\n" +
          "  --version     Show the version\n",
      ),
      help.stdout,
    );
    assert.ok(help.stdout.includes("Exit codes: 0 ok, 1 LinkedIn or auth error, 2 usage error."), help.stdout);
  });

  test("--version prints exactly package.json's version", async () => {
    const { version } = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const result = await run(["--version"], { env: {} });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
    const help = await run(["--help"], { env: {} });
    assert.ok(help.stdout.startsWith(`Unlinked ${version}: your LinkedIn profile as JSON, for you and your AI tools.\n`), help.stdout.slice(0, 120));
  });
});

describe("errors and exit codes", () => {
  test("a missing token exits 1 with a clear message and no output on stdout", async () => {
    const r = await run(["profile"], { env: {} });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.errorJson().error, /LINKEDIN_TOKEN/);
    assert.equal(r.fake.urls.length, 0);
  });

  test("blocked and unknown sections exit 2 without needing a token or the network, each with its own message", async () => {
    for (const name of ["inbox", "login"]) {
      const r = await run(["section", name], { env: {} });
      assert.equal(r.code, 2, name);
      assert.equal(r.stdout, "");
      assert.equal(r.errorJson().error, `The "${name}" section is not available: it holds sensitive data that Unlinked never reads.`, name);
      assert.equal(r.fake.urls.length, 0);
    }
    for (const name of ["POSITIONS", "nonsense"]) {
      const r = await run(["section", name], { env: {} });
      assert.equal(r.code, 2, name);
      assert.equal(r.stdout, "");
      assert.match(r.errorJson().error, new RegExp(`^Unknown section "${name}"\\. Available sections: intro, experience, education, .*, job-postings, learning\\.$`), name);
      assert.equal(r.fake.urls.length, 0);
    }
    const profile = await run(["profile", "--sections", "inbox"], { env: {} });
    assert.equal(profile.code, 2);
    assert.equal(profile.errorJson().error, 'The "inbox" section is not available: it holds sensitive data that Unlinked never reads.');
  });

  test("usage errors exit 2 with a message that names the problem (more cases: cli-edge.test.ts)", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["frobnicate"], /^Unknown command "frobnicate"\. Try: /],
      [[], /^Missing command\. Try: /],
      [["--bogus"], /^Unknown option '--bogus'/],
      [["section"], /^Usage: unlinked section <id>/],
      [["cache"], /^Usage: unlinked cache clear$/],
      [["cache", "nuke"], /^Usage: unlinked cache clear$/],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv);
      assert.equal(r.code, 2, JSON.stringify(argv));
      assert.equal(r.stdout, "", JSON.stringify(argv));
      assert.match(r.errorJson().error, message, JSON.stringify(argv));
    }
  });

  test("an API error prints JSON with status on stderr and exits 1", async () => {
    const r = await run(["activity", "--no-cache"], { fake: { changelogStatus: 403 } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    const error = r.errorJson();
    assert.equal(error.status, 403);
    assert.match(error.error, /denied access/);
    assert.doesNotMatch(r.stderr, new RegExp(TOKEN));
  });
});

describe("warnings", () => {
  test("a non-default LINKEDIN_API_VERSION and a bad UNLINKED_CACHE_TTL warn on stderr; stdout stays JSON", async () => {
    const r = await run(["profile", "--no-cache"], {
      env: { LINKEDIN_TOKEN: TOKEN, LINKEDIN_API_VERSION: "202501", UNLINKED_CACHE_TTL: "banana" },
    });
    assert.equal(r.code, 0);
    assert.equal(
      r.stderr,
      "unlinked: warning: LINKEDIN_API_VERSION=202501 is ignored: LinkedIn's Member Data Portability API only accepts 202312.\n" +
        "unlinked: warning: UNLINKED_CACHE_TTL=banana is not valid (use 30m, 2h, 1d or 0); using the 6h default.\n",
    );
    assert.equal(r.json().intro.headline, "Builder");
  });
});

describe("cache flags", () => {
  test("the second call is served from the disk cache; --refresh refetches", async () => {
    const dir = await tempDir();
    const first = await run(["profile"], { cacheDir: dir });
    assert.equal(first.fake.urls.length, 7);
    const second = await run(["profile"], { cacheDir: dir });
    assert.equal(second.fake.urls.length, 0);
    assert.deepEqual(second.json().intro, first.json().intro);
    const refreshed = await run(["profile", "--refresh"], { cacheDir: dir });
    assert.equal(refreshed.fake.urls.length, first.fake.urls.length);
  });

  test("--no-cache neither reads nor writes", async () => {
    const dir = await tempDir();
    await run(["profile"], { cacheDir: dir });
    const r = await run(["profile", "--no-cache"], { cacheDir: dir });
    assert.equal(r.fake.urls.length, 7);
    const empty = await tempDir();
    await run(["profile", "--no-cache"], { cacheDir: empty });
    assert.deepEqual(await readdir(empty), []);
  });

  test("cache clear removes the cache without needing a token", async () => {
    const dir = await tempDir();
    await run(["profile"], { cacheDir: dir });
    await access(join(dir, "unlinked"));
    const r = await run(["cache", "clear"], { cacheDir: dir, env: {} });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json(), { cleared: true });
    await assert.rejects(access(join(dir, "unlinked")));
    const again = await run(["cache", "clear"], { cacheDir: dir, env: {} });
    assert.equal(again.code, 0);
  });
});
