#!/usr/bin/env node
process.on("unhandledRejection", (reason) => {
  console.error(`[unlinked] unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
});
process.on("uncaughtException", (error) => {
  console.error(`[unlinked] uncaught exception: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

// The reader of our stdout went away (`unlinked ... | head`, or an MCP client that exited): stop quietly.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

const args = process.argv.slice(2);

const wantsInfo = args.includes("--help") || args.includes("--version");
if (args.includes("--mcp") && !wantsInfo && args.length > 1) {
  console.error(JSON.stringify({ error: "--mcp starts the MCP server and takes no other arguments. Run: unlinked --mcp" }));
  process.exit(2);
}

if (args.includes("--mcp") && !wantsInfo) {
  // MCP server: stdout belongs to the protocol, diagnostics go to stderr.
  const [{ StdioServerTransport }, { readLinkedInRuntimeConfig }, { createUnlinkedServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./linkedin/config.js"),
    import("./mcp/server.js"),
  ]);

  let config;
  try {
    config = readLinkedInRuntimeConfig();
  } catch (error) {
    console.error(`[unlinked] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  for (const warning of config.warnings) {
    console.error(`[unlinked] warning: ${warning}`);
  }

  const server = createUnlinkedServer({ linkedInConfig: config });
  await server.connect(new StdioServerTransport());
} else {
  const { runCli } = await import("./cli.js");
  // `--mcp --help` / `--mcp --version`: answer the question, do not start a server.
  process.exitCode = await runCli(args.filter((arg) => arg !== "--mcp"));
}
