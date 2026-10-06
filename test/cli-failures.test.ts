import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TOKEN, run } from "./helpers/run-cli.js";
import { tempDir } from "./helpers/temp-dir.js";

const snapshots = {
  PROFILE: [{ "First Name": "Ada", Headline: "Builder" }],
  SKILLS: [{ Name: "TypeScript" }],
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("every upstream failure exits 1 with one JSON line on stderr and nothing on stdout", () => {
  const failures: Array<[string, () => Response | Promise<Response>, number | undefined]> = [
    ["401", () => json(401, { message: "Invalid access token", status: 401 }), 401],
    ["403", () => json(403, { message: "Not enough permissions", serviceErrorCode: 100, status: 403 }), 403],
    ["404", () => json(404, { message: "Not found", status: 404 }), 404],
    ["429 with Retry-After", () => json(429, { message: "Too many requests" }, { "retry-after": "30" }), 429],
    ["500", () => json(500, { message: "oops" }), 500],
    ["503 with an HTML body", () => new Response("<html><h1>Service Unavailable</h1></html>", { status: 503 }), 503],
    ["200 with malformed JSON", () => new Response("{not json", { status: 200 }), 200],
    ["200 with an HTML body", () => new Response("<html>login</html>", { status: 200 }), 200],
    ["500 with an empty body", () => new Response("", { status: 500 }), 500],
    ["network failure", () => Promise.reject(new TypeError("fetch failed")), undefined],
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), undefined],
  ];

  for (const [name, respond, status] of failures) {
    test(name, async () => {
      for (const argv of [["activity", "--no-cache"], ["status"], ["section", "skills", "--no-cache"]]) {
        const r = await run(argv, { fetchImpl: (async () => respond()) as typeof fetch });
        const label = `${name}: ${argv.join(" ")}`;
        // A 404 on a snapshot just means "no data"; everything else is a failure.
        if (name === "404" && argv[0] === "section") {
          assert.equal(r.code, 0, label);
          continue;
        }
        assert.equal(r.code, 1, label);
        assert.equal(r.stdout, "", label);
        assert.equal(r.stderr.trim().split("\n").length, 1, label);
        const error = r.errorJson();
        assert.ok(typeof error.error === "string" && error.error.length > 0, label);
        assert.equal(error.status, status, label);
        assert.ok(!r.stderr.includes(TOKEN), label);
        assert.ok(!r.stderr.includes("<html"), label);
      }
    });
  }

  test("a 429 with a long Retry-After tells the user how long to wait", async () => {
    const r = await run(["activity", "--no-cache"], { fetchImpl: (async () => json(429, {}, { "retry-after": "7200" })) as typeof fetch });
    assert.equal(r.code, 1);
    assert.match(r.errorJson().error, /retry after about 2 hours/i);
  });
});

describe("request id in the error JSON", () => {
  const fail = (headers: Record<string, string>) =>
    run(["status"], { fetchImpl: (async () => json(403, { message: "denied" }, headers)) as typeof fetch });

  test("x-li-uuid, then x-restli-id, then x-li-fabric", async () => {
    assert.equal((await fail({ "x-li-uuid": "uuid-1", "x-restli-id": "r", "x-li-fabric": "f" })).errorJson().requestId, "uuid-1");
    assert.equal((await fail({ "x-restli-id": "restli-1", "x-li-fabric": "f" })).errorJson().requestId, "restli-1");
    assert.equal((await fail({ "x-li-fabric": "fabric-1" })).errorJson().requestId, "fabric-1");
  });

  test("no header means no requestId key", async () => {
    const r = await fail({});
    assert.equal(r.code, 1);
    assert.equal("requestId" in r.errorJson(), false);
    assert.equal(r.errorJson().status, 403);
  });
});

describe("a tampered activity cursor is a usage error (exit 2), not a crash", () => {
  const encode = (text: string) => Buffer.from(text).toString("base64url");
  for (const since of ['"x"', "1e999", "1e300", "null"]) {
    test(`since ${since}`, async () => {
      const cursor = encode(`{"scope":"activity","offset":1,"asOf":1,"since":${since}}`);
      const r = await run(["activity", "--cursor", cursor], { env: {} });
      assert.equal(r.code, 2, r.stderr);
      assert.equal(r.stdout, "");
      assert.equal(r.errorJson().error, "Invalid cursor. Use the nextCursor value from the previous page.");
      assert.equal(r.fake.urls.length, 0);
    });
  }
});

describe("partial failure: snapshot works, changelog fails", () => {
  test("profile still succeeds and says why recent changes are missing; activity exits 1", async () => {
    const profile = await run(["profile", "--no-cache"], { fake: { snapshots, changelogStatus: 403 } });
    assert.equal(profile.code, 0);
    assert.equal(profile.stderr, "");
    assert.equal(profile.json().skills.length, 1);
    assert.match(profile.json().freshness.recentChangesError, /denied access/);

    const activity = await run(["activity", "--no-cache"], { fake: { snapshots, changelogStatus: 403 } });
    assert.equal(activity.code, 1);
    assert.equal(activity.stdout, "");
  });

  test("a changelog 404 is tolerated by profile and fatal for activity", async () => {
    const profile = await run(["profile", "--no-cache"], { fake: { snapshots, changelogStatus: 404 } });
    assert.equal(profile.code, 0);
    assert.equal(
      profile.json().freshness.recentChangesError,
      "LinkedIn found no data for this request, or the API is restricted for this application. denied",
    );
    assert.equal((await run(["activity", "--no-cache"], { fake: { changelogStatus: 404 } })).code, 1);
  });

  test("an empty changelog body is just no events", async () => {
    const fetchImpl = (async () => new Response("", { status: 200 })) as typeof fetch;
    const r = await run(["activity", "--no-cache"], { fetchImpl });
    assert.equal(r.code, 0);
    assert.equal(r.json().total, 0);
  });
});

describe("the disk cache is best-effort", () => {
  // A file where the cache folder should be makes every mkdir/write fail, for root as well (chmod would not stop root).
  test("a cache location that cannot be created does not break the command", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "unlinked");
    await writeFile(blocker, "i am in the way");
    const r = await run(["profile"], { cacheDir: dir, fake: { snapshots } });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.equal(r.json().skills.length, 1);
    assert.equal(await readFile(blocker, "utf8"), "i am in the way");
    assert.deepEqual(await readdir(dir), ["unlinked"]);
  });

  test("a cache directory that is actually a file does not break profile or cache clear", async () => {
    const dir = await tempDir();
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    const profile = await run(["profile"], { cacheDir: file, fake: { snapshots } });
    assert.equal(profile.code, 0);
    const clear = await run(["cache", "clear"], { cacheDir: file, env: {} });
    assert.equal(clear.code, 0, clear.stderr);
    assert.equal(await readFile(file, "utf8"), "x");
  });

  const cacheFiles = async (dir: string) => {
    const base = join(dir, "unlinked");
    const [tokenDir] = await readdir(base);
    const names = await readdir(join(base, tokenDir!));
    return names.map((name) => join(base, tokenDir!, name));
  };

  test("cache files with valid JSON of the wrong shape are refetched, not trusted", async () => {
    const dir = await tempDir();
    const first = await run(["profile"], { cacheDir: dir, fake: { snapshots } });
    assert.equal(first.code, 0);
    for (const bad of [null, 5, "text", [], { rows: "not an array", empty: false, truncated: false }, { events: 3 }]) {
      for (const file of await cacheFiles(dir)) {
        await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data: bad }));
      }
      const r = await run(["profile"], { cacheDir: dir, fake: { snapshots } });
      assert.equal(r.code, 0, JSON.stringify(bad));
      assert.equal(r.fake.urls.length, 7, JSON.stringify(bad));
      assert.equal(r.json().skills.length, 1);
    }
  });

  test("a cache file stamped in the future is not trusted", async () => {
    const dir = await tempDir();
    await run(["profile"], { cacheDir: dir, fake: { snapshots } });
    for (const file of await cacheFiles(dir)) {
      const entry = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...entry, fetchedAt: Date.now() + 10 * 365 * 86_400_000 }));
    }
    const r = await run(["profile"], { cacheDir: dir, fake: { snapshots } });
    assert.equal(r.fake.urls.length, 7);
  });

  test("an expired cache refetches", async () => {
    const dir = await tempDir();
    await run(["profile"], { cacheDir: dir, fake: { snapshots } });
    assert.equal((await run(["profile"], { cacheDir: dir, fake: { snapshots } })).fake.urls.length, 0);
    for (const file of await cacheFiles(dir)) {
      const entry = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...entry, fetchedAt: Date.now() - 7 * 3_600_000 }));
    }
    assert.equal((await run(["profile"], { cacheDir: dir, fake: { snapshots } })).fake.urls.length, 7);
  });

  test("another token never reads this token's cache", async () => {
    const dir = await tempDir();
    await run(["profile"], { cacheDir: dir, fake: { snapshots } });
    const other = await run(["profile"], { cacheDir: dir, env: { LINKEDIN_TOKEN: "another-synthetic-token" }, fake: { snapshots } });
    assert.equal(other.fake.urls.length, 7);
    assert.deepEqual(other.fake.authorizations.filter((a) => a !== "Bearer another-synthetic-token"), []);
    assert.equal((await readdir(join(dir, "unlinked"))).length, 2);
  });

  test("--no-cache with --refresh fetches and writes nothing", async () => {
    const dir = await tempDir();
    const r = await run(["profile", "--no-cache", "--refresh"], { cacheDir: dir, fake: { snapshots } });
    assert.equal(r.code, 0);
    assert.equal(r.fake.urls.length, 7);
    assert.deepEqual(await readdir(dir), []);
  });

  test("UNLINKED_CACHE_TTL: valid values cache silently; invalid ones warn and still use the 6h default; 0 turns it off", async () => {
    for (const [ttl, warns, caches] of [["30m", false, true], ["2h", false, true], ["", false, true], ["0", false, false], ["abc", true, true], ["-5m", true, true], ["1.5h", true, true]] as const) {
      const dir = await tempDir();
      const r = await run(["profile"], { cacheDir: dir, env: { LINKEDIN_TOKEN: TOKEN, UNLINKED_CACHE_TTL: ttl }, fake: { snapshots } });
      assert.equal(r.code, 0, ttl);
      assert.equal(/UNLINKED_CACHE_TTL/.test(r.stderr), warns, ttl);
      assert.equal((await readdir(dir)).length > 0, caches, ttl);
    }
  });

  test("a cache that was written with a 2h TTL is still honoured inside it, and an expired one is not", async () => {
    const dir = await tempDir();
    // Every default section has rows: an empty section would use the 10 minute empty TTL instead.
    const full = { ...snapshots, POSITIONS: [{ Title: "Eng" }], EDUCATION: [{ "School Name": "U" }], CERTIFICATIONS: [{ Name: "C" }], PROJECTS: [{ Title: "P" }] };
    const env = { LINKEDIN_TOKEN: TOKEN, UNLINKED_CACHE_TTL: "2h" };
    await run(["profile"], { cacheDir: dir, env, fake: { snapshots: full } });
    const stamp = async (ageMs: number) => {
      for (const file of await cacheFiles(dir)) {
        const entry = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify({ ...entry, fetchedAt: Date.now() - ageMs }));
      }
    };
    await stamp(100 * 60_000); // 1h40 old: inside the 2h TTL
    const honoured = await run(["profile"], { cacheDir: dir, env, fake: { snapshots: full } });
    assert.equal(honoured.code, 0);
    assert.equal(honoured.fake.urls.length, 0);
    await stamp(3 * 3_600_000); // older than 2h, still inside the 6h default
    const expired = await run(["profile"], { cacheDir: dir, env, fake: { snapshots: full } });
    assert.equal(expired.fake.urls.length, 7);
  });
});
