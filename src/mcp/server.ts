import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";

import { Cache } from "../cache.js";
import { LinkedInClient } from "../linkedin/client.js";
import { readLinkedInRuntimeConfig, type LinkedInRuntimeConfig } from "../linkedin/config.js";
import { createService, type Service } from "../service.js";
import { registerLinkedInTools } from "../tools/linkedin.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../../package.json") as { version: string };

export type CreateUnlinkedServerOptions = {
  /** Inject a ready-made service (tests). Otherwise one is built from the config. */
  service?: Service;
  linkedInConfig?: LinkedInRuntimeConfig;
  fetchImpl?: typeof fetch;
};

export function createUnlinkedServer({
  service,
  linkedInConfig,
  fetchImpl,
}: CreateUnlinkedServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "unlinked-mcp-server",
    version: SERVER_VERSION,
  });

  registerLinkedInTools(server, { service: service ?? buildService(linkedInConfig ?? readLinkedInRuntimeConfig(), fetchImpl) });

  return server;
}

/** The MCP server keeps its cache in memory only; nothing is written to disk. */
function buildService(config: LinkedInRuntimeConfig, fetchImpl?: typeof fetch): Service {
  return createService({
    client: new LinkedInClient(fetchImpl ? { fetchImpl } : {}),
    cache: new Cache({ token: config.accessToken, ttlMs: config.cacheTtlMs }),
    accessToken: config.accessToken,
  });
}
