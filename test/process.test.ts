import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { tempDir } from "./helpers/temp-dir.js";

const TOKEN = "synthetic-secret-token-value";
const STUB = join(import.meta.dirname, "helpers", "stub-linkedin-fetch.mjs");
const ENTRY = join(import.meta.dirname, "..", "src", "index.ts");
const baseEnv = (home: string) => ({ PATH: process.env.PATH ?? "", HOME: home, XDG_CACHE_HOME: join(home, "cache") });
const nodeArgs = (...args: string[]) => ["--import", "tsx", "--import", STUB, ENTRY, ...args];
/** tsx may print its own deprecation warning on stderr; our lines and the stub's are the rest. */
/** Every path under `root` whose last segment is `name` (a directory or a file). */
async function findNamed(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name === name) {
      found.push(path);
    }
    if (entry.isDirectory()) {
      found.push(...(await findNamed(path, name)));
    }
  }
  return found;
}
const ourStderr = (text: string) => text.split("\n").filter((line) => line && !/DEP0205|trace-deprecation/.test(line));

describe("real CLI process", () => {
  test("profile prints JSON on stdout, exits 0 and keeps the token out of both streams", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("profile", "--compact", "--no-cache"), { env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const profile = JSON.parse(r.stdout);
    assert.equal(profile.intro.firstName, "Ada");
    assert.equal(profile.intro.birthDate, undefined);
    assert.equal(profile.skills[1].name, "Rüst");
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
    assert.ok(ourStderr(r.stderr).every((line) => line.startsWith("stub-fetch ")), r.stderr);
  });

  test("a 401 exits 1 with a single JSON error on stderr and an empty stdout", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("section", "skills", "--no-cache"), { env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN, UNLINKED_STUB: "denied" }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    const errorLine = ourStderr(r.stderr).filter((line) => !line.startsWith("stub-fetch ")).join("\n");
    assert.equal(JSON.parse(errorLine).status, 401);
    assert.ok(!r.stderr.includes(TOKEN));
  });

  test("a blocked section exits 2 with one JSON error line and nothing on stdout", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("section", "inbox"), { env: baseEnv(home), encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.deepEqual(ourStderr(r.stderr).map((line) => JSON.parse(line)), [
      { error: 'The "inbox" section is not available: it holds sensitive data that Unlinked never reads.' },
    ]);
  });

  test("an unknown command exits 2 and says so", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("frobnicate"), { env: baseEnv(home), encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(JSON.parse(ourStderr(r.stderr)[0]!).error, /^Unknown command "frobnicate"/);
  });

  test("the CLI writes its cache under the OS cache dir of the temp home (so the MCP check below can see a cache)", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("section", "skills"), { env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const found = await findNamed(home, "unlinked");
    assert.equal(found.length, 1, found.join(","));
    // macOS ignores XDG_CACHE_HOME (the test sets it to <home>/cache); every other platform honours it.
    const expected = process.platform === "darwin" ? join(home, "Library", "Caches", "unlinked") : join(home, "cache", "unlinked");
    assert.equal(found[0], expected);
  });

  test("a usage error exits 2 and never touches LinkedIn", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("section", "reactions", "--limit", "0"), { env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN }, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes("stub-fetch"));
  });

  test("the old --stdio flag exits 2 and points at --mcp (it must not start a server)", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("--stdio"), { env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN }, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /--mcp/);
  });

  test("--mcp together with anything else is a usage error and must not start a server", async () => {
    const home = await tempDir();
    for (const args of [["--mcp", "profile"], ["section", "skills", "--mcp"], ["--mcp", "--refresh"]]) {
      const r = spawnSync(process.execPath, nodeArgs(...args), { env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN }, encoding: "utf8", timeout: 10_000, input: "" });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /--mcp/);
    }
  });

  test("--help and --version win over --mcp", async () => {
    const home = await tempDir();
    for (const [flag, pattern] of [["--help", /Usage/], ["--version", /^\d+\.\d+\.\d+/]] as const) {
      const r = spawnSync(process.execPath, nodeArgs("--mcp", flag), { env: baseEnv(home), encoding: "utf8", timeout: 10_000, input: "" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, pattern);
    }
  });

  test("a closed stdout pipe (EPIPE) ends quietly instead of crashing", async () => {
    const home = await tempDir();
    const child = spawn(process.execPath, nodeArgs("--help"), { env: baseEnv(home), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.deepEqual(ourStderr(stderr), []);
  });
});

describe("real MCP process (--mcp)", () => {
  test("without a token it fails clearly on stderr with exit 1 and prints nothing on stdout", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("--mcp"), { env: baseEnv(home), encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /LINKEDIN_TOKEN/);
  });

  test("with a token that cannot be a header it fails at startup without echoing it", async () => {
    const home = await tempDir();
    const r = spawnSync(process.execPath, nodeArgs("--mcp"), { env: { ...baseEnv(home), LINKEDIN_TOKEN: "abc-secret def-secret" }, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes("abc-secret"));
  });

  async function withServer(mode: string, body: (client: Client, stderr: () => string, protocolErrors: unknown[], home: string) => Promise<void>) {
    const home = await tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeArgs("--mcp"),
      env: { ...baseEnv(home), LINKEDIN_TOKEN: TOKEN, UNLINKED_STUB: mode },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    // Any non-JSON-RPC line on stdout would surface here as a parse error.
    const protocolErrors: unknown[] = [];
    transport.onerror = (error) => protocolErrors.push(error);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      await client.listTools();
      await body(client, () => stderr, protocolErrors, home);
    } finally {
      await client.close();
    }
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text: string }> };

  test("serves every tool over real stdio, survives errors, and keeps stdout pure JSON-RPC", async () => {
    await withServer("ok", async (client, stderr, protocolErrors, home) => {
      const profile = await call(client, "linkedin_get_profile", { sections: ["intro", "skills"] });
      assert.equal(profile.structuredContent?.intro.firstName, "Ada");
      assert.equal(profile.structuredContent?.skills.length, 2);

      const bad = [
        await call(client, "linkedin_get_section", { section: "reactions", limit: 0 }),
        await call(client, "linkedin_get_section", { section: "inbox" }),
        await call(client, "linkedin_get_section", { section: "reactions", cursor: "garbage" }),
        await call(client, "linkedin_get_recent_activity", { since: "junk" }),
      ];
      assert.ok(bad.every((r) => r.isError === true));

      const page = await call(client, "linkedin_get_section", { section: "reactions", limit: 2 });
      assert.equal(page.structuredContent?.items.length, 2);
      const next = await call(client, "linkedin_get_section", { section: "reactions", limit: 2, cursor: page.structuredContent?.nextCursor });
      assert.equal(next.structuredContent?.items.length, 2);

      assert.equal((await call(client, "linkedin_get_recent_activity")).structuredContent?.total, 0);
      assert.equal((await call(client, "linkedin_check_access")).structuredContent?.connected, true);

      assert.deepEqual(protocolErrors, []);
      assert.ok(!stderr().includes(TOKEN));
      const requests = stderr().split("\n").filter((line) => line.startsWith("stub-fetch /rest/memberChangeLogs"));
      assert.equal(requests.length, 1, "the changelog is fetched once and then cached in memory");
      // The MCP server is memory-only: after a full session no cache directory exists under the temp HOME or XDG_CACHE_HOME.
      assert.deepEqual(await findNamed(home, "unlinked"), []);
    });
  });

  test("a 401 on one call does not poison the next one", async () => {
    await withServer("flaky401", async (client, stderr) => {
      const failed = await call(client, "linkedin_get_section", { section: "skills" });
      assert.equal(failed.isError, true);
      assert.match(failed.content[0]!.text, /401/);
      const retried = await call(client, "linkedin_get_section", { section: "skills" });
      assert.equal(retried.isError, undefined);
      assert.equal(retried.structuredContent?.total, 2);
      assert.ok(!stderr().includes(TOKEN));
    });
  });

  test("concurrent calls share fetches", async () => {
    await withServer("ok", async (client, stderr) => {
      const results = await Promise.all(Array.from({ length: 4 }, () => call(client, "linkedin_get_section", { section: "reactions" })));
      assert.ok(results.every((r) => r.structuredContent?.total === 5));
      const snapshotRequests = stderr().split("\n").filter((line) => line.startsWith("stub-fetch /rest/memberSnapshotData"));
      assert.equal(snapshotRequests.length, 1);
    });
  });
});
