import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CACHE_TTL_ENV, LINKEDIN_TOKEN_ENV } from "../src/linkedin/config.js";
import { SECTIONS } from "../src/linkedin/sections.js";
import { createUnlinkedServer } from "../src/mcp/server.js";
import type { Service } from "../src/service.js";
import { run } from "./helpers/run-cli.js";

// Checks that the packaging files, the README and the code still agree. Nothing here needs a build or the network.
const ROOT = join(import.meta.dirname, "..");
const text = (file: string) => readFileSync(join(ROOT, file), "utf8");
const json = (file: string) => JSON.parse(text(file)) as any;

const pkg = json("package.json");
const server = json("server.json");
const readme = text("README.md");

/** The README from one heading to the next heading of the same level. */
function readmeSection(heading: string): string {
  const start = readme.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `README has no "## ${heading}" section`);
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  return end === -1 ? rest : rest.slice(0, end);
}

/** First cell of every row of the markdown tables in `markdown`, without the header and separator rows. */
const firstCells = (markdown: string): string[] =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.split("|")[1]!.trim());

describe("versions", () => {
  test("package.json is a plain x.y.z version", () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  });

  test("server.json version and its npm package version equal package.json's (the release workflow bumps all three)", () => {
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0].version, pkg.version);
  });
});

describe("server.json", () => {
  const entry = server.packages[0];

  test("starts the package as an MCP server over stdio: the --mcp argument is there", () => {
    assert.equal(entry.transport.type, "stdio");
    assert.ok(entry.packageArguments.some((arg: { value: string }) => arg.value === "--mcp"), JSON.stringify(entry.packageArguments));
  });

  test("points at this npm package and this MCP name", () => {
    assert.equal(entry.registryType, "npm");
    assert.equal(entry.identifier, pkg.name);
    assert.equal(server.name, pkg.mcpName);
  });

  test("declares exactly the environment variables the code reads: the token and the cache lifetime, no API version", () => {
    const names: string[] = entry.environmentVariables.map((variable: { name: string }) => variable.name);
    assert.deepEqual(names.sort(), [CACHE_TTL_ENV, LINKEDIN_TOKEN_ENV].sort());
    assert.deepEqual(names.sort(), ["LINKEDIN_TOKEN", "UNLINKED_CACHE_TTL"]);
    assert.ok(!names.includes("LINKEDIN_API_VERSION"));
    const byName = Object.fromEntries(entry.environmentVariables.map((variable: { name: string }) => [variable.name, variable]));
    assert.deepEqual([byName.LINKEDIN_TOKEN.isRequired, byName.LINKEDIN_TOKEN.isSecret], [true, true]);
    assert.deepEqual([byName.UNLINKED_CACHE_TTL.isRequired, byName.UNLINKED_CACHE_TTL.isSecret], [false, false]);
  });
});

describe("package.json", () => {
  test("the unlinked command is the compiled entry point, and the build output is what gets published", () => {
    assert.deepEqual(pkg.bin, { unlinked: "dist/index.js" });
    assert.equal(pkg.main, "dist/index.js");
    assert.ok(pkg.files.includes("dist"), JSON.stringify(pkg.files));
    // tsconfig compiles src/ to dist/, so dist/index.js comes from src/index.ts.
    const tsconfig = json("tsconfig.json");
    assert.equal(tsconfig.compilerOptions.rootDir, "src");
    assert.equal(tsconfig.compilerOptions.outDir, "dist");
    assert.ok(existsSync(join(ROOT, "src", "index.ts")));
    assert.ok(text("src/index.ts").startsWith("#!/usr/bin/env node\n"), "the entry point needs its shebang to run as a command");
  });

  test("every other published file exists", () => {
    for (const file of pkg.files.filter((name: string) => name !== "dist")) {
      assert.ok(existsSync(join(ROOT, file)), file);
    }
    assert.ok(pkg.files.includes("logo.png"));
  });

  test("no script carries a token, and the inspector script starts the MCP server", () => {
    for (const [name, script] of Object.entries(pkg.scripts) as Array<[string, string]>) {
      assert.doesNotMatch(script, /LINKEDIN_TOKEN|Bearer/i, name);
    }
    assert.match(pkg.scripts.inspect, / --mcp$/);
  });

  test("the Node version in the README is the one in engines", () => {
    assert.equal(pkg.engines.node, ">=22.0.0");
    assert.match(readme, /You need Node\.js 22\+/);
  });
});

describe("docs about the API version", () => {
  test("every mention of LINKEDIN_API_VERSION in the README and AGENTS.md says it is ignored (the version is pinned in code)", () => {
    for (const file of ["README.md", "AGENTS.md"]) {
      const lines = text(file).split("\n").filter((line) => line.includes("LINKEDIN_API_VERSION"));
      assert.ok(lines.length >= 1, `${file} should explain what happened to LINKEDIN_API_VERSION`);
      for (const line of lines) {
        assert.match(line, /is ignored|no longer used/, `${file}: ${line}`);
      }
      assert.doesNotMatch(text(file), /LINKEDIN_API_VERSION[^\n]*(defaults? to|configured|set it)/i, file);
    }
  });
});

describe("release workflow", () => {
  const workflow = text(".github/workflows/publish-mcp.yml");
  const lines = workflow.split("\n");

  test("installs with --ignore-scripts and nothing runs npm ci without it", () => {
    const installs = lines.filter((line) => /\bnpm (ci|install|i)\b/.test(line));
    assert.ok(installs.length >= 1);
    for (const line of installs) {
      assert.match(line, /--ignore-scripts/, line);
    }
  });

  test("every action is pinned to a 40-hex commit SHA with a version comment", () => {
    const uses = lines.filter((line) => /^\s*(- )?uses:/.test(line));
    assert.ok(uses.length >= 2);
    for (const line of uses) {
      assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+/, line);
    }
  });

  test("mcp-publisher is a pinned release whose sha256 is checked against the published checksums before it is extracted", () => {
    assert.ok(!workflow.includes("releases/latest"));
    assert.match(workflow, /MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+/);
    const check = lines.findIndex((line) => /sha256sum --check/.test(line));
    const extract = lines.findIndex((line) => /\btar x/.test(line));
    assert.ok(check !== -1 && extract !== -1 && check < extract, `check line ${check}, extract line ${extract}`);
    assert.match(workflow, /_checksums\.txt/);
  });

  test("publishes to npm with provenance and keeps id-token: write; the only trigger is workflow_dispatch", () => {
    assert.match(workflow, /npm publish --provenance /);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
    assert.deepEqual(workflow.match(/^on:\n((?: {2}\S.*\n?|(?: {4,}.*)\n?)*)/m)![1]!.match(/^ {2}[a-z_]+:/gm), ["  workflow_dispatch:"]);
  });

  test("checkout does not persist credentials, and the push step passes the token itself", () => {
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /extraheader=AUTHORIZATION: basic/);
  });
});

describe("README", () => {
  test("has a Security section: other people's text is untrusted, and what the disk cache holds and how to clear it", () => {
    const security = readmeSection("Security");
    assert.match(security, /untrusted/i);
    assert.match(security, /recommendations/i);
    assert.match(security, /invitation/i);
    assert.match(security, /prompt injection|instructions found in it/i);
    assert.match(security, /6 hours/);
    assert.match(security, /plaintext/i);
    assert.match(security, /token is never written/i);
    assert.match(security, /unlinked cache clear/);
  });

  test("tells people to use --mcp, and mentions the removed --stdio nowhere (README, server.json, package.json, .env.example)", () => {
    assert.match(readme, /--mcp/);
    for (const [name, content] of [["README.md", readme], ["server.json", text("server.json")], ["package.json", text("package.json")], [".env.example", text(".env.example")]]) {
      assert.ok(!content!.includes("--stdio"), `${name} mentions --stdio`);
    }
  });

  test("every MCP client config in the README runs this package with --mcp", () => {
    const configs = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!) as any);
    const args = configs.flatMap((config) => Object.values(config.mcpServers ?? config.servers ?? {}).map((entry: any) => entry.args as string[]));
    assert.ok(args.length >= 2, "expected the Claude Desktop and VS Code configs");
    for (const list of args) {
      assert.ok(list.includes(pkg.name), JSON.stringify(list));
      assert.ok(list.includes("--mcp"), JSON.stringify(list));
    }
  });

  test("the commands the README shows are the commands the CLI help lists, and every README flag is in the help", async () => {
    const help = (await run(["--help"], { env: {} })).stdout;
    const commandsIn = (content: string) => [...new Set([...content.matchAll(/^\s*unlinked ([a-z]+)\b/gm)].map((match) => match[1]!))].sort();
    assert.deepEqual(commandsIn(readme), ["activity", "cache", "profile", "section", "status"]);
    assert.deepEqual(commandsIn(help), commandsIn(readme));
    const flags = [...new Set([...readme.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((match) => match[0]))];
    assert.ok(flags.length >= 8, flags.join(" "));
    for (const flag of flags) {
      assert.ok(help.includes(flag), `${flag} is in the README but not in --help`);
    }
  });

  test("the sections table, the CLI help and the code list the same section ids", async () => {
    const ids = SECTIONS.map((section) => section.id).sort();
    const fromTable = firstCells(readmeSection("Sections")).flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
    assert.deepEqual([...fromTable].sort(), ids);
    const help = (await run(["--help"], { env: {} })).stdout;
    const listed = help.slice(help.indexOf("Sections: ") + "Sections: ".length).replace(/\.\n$/, "").split(/,\s*/);
    assert.deepEqual([...listed].sort(), ids);
  });

  test("the configuration table lists the variables in server.json", () => {
    const names = firstCells(readmeSection("Configuration")).map((cell) => cell.replaceAll("`", ""));
    assert.deepEqual(names.sort(), server.packages[0].environmentVariables.map((variable: { name: string }) => variable.name).sort());
  });

  test("the tools table lists the tools the server registers", async () => {
    const mcp = createUnlinkedServer({ service: {} as Service });
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const registered = (await client.listTools()).tools.map((tool) => tool.name).sort();
    await client.close();
    const tools = firstCells(readme.slice(readme.indexOf("### Tools")).split("\n## ")[0]!).map((cell) => cell.replaceAll("`", ""));
    assert.deepEqual(tools.sort(), registered);
  });
});
