import { createRequire } from "node:module";
import { parseArgs } from "node:util";

import { Cache, clearAllDiskCache, defaultCacheDir } from "./cache.js";
import { LinkedInApiError, LinkedInClient } from "./linkedin/client.js";
import { readLinkedInRuntimeConfig } from "./linkedin/config.js";
import { UsageError, checkCursor, createService, parseSince, resolveProfileSections, resolveSection } from "./service.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

export type CliIo = {
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  fetchImpl?: typeof fetch;
  /** Base directory for the disk cache (the OS cache directory by default). */
  cacheDir?: string;
  /** Retry attempts for transient LinkedIn failures (tests set 0). */
  maxRetries?: number;
};

const HELP = `Unlinked ${VERSION}: your LinkedIn profile as JSON, for you and your AI tools.

Usage:
  unlinked profile [--sections intro,skills] [--all]
  unlinked section <id> [--limit N] [--cursor C] [--all-items]
  unlinked activity [--since 7d|<ISO date>|<epoch ms>] [--limit N] [--cursor C]
  unlinked status
  unlinked cache clear
  unlinked --mcp                 Run as an MCP server over stdio (the transport)

Flags:
  --refresh     Ignore the local cache and fetch fresh data from LinkedIn
  --no-cache    Do not read or write the local cache
  --compact     Print one-line JSON
  --help        Show this help
  --version     Show the version

Environment:
  LINKEDIN_TOKEN       LinkedIn access token (Member Data Portability, EEA and Switzerland only)
  UNLINKED_CACHE_TTL   Cache lifetime, e.g. 30m, 2h, 1d or 0 to turn it off (default 6h)

Results are JSON on stdout. Errors are JSON on stderr. Exit codes: 0 ok, 1 LinkedIn or auth error, 2 usage error.
Sections: intro, experience, education, skills, certifications, projects, languages, volunteering, honors,
courses, publications, patents, test-scores, organizations, causes, recommendations, services, endorsements-given,
posts, comments, reactions, reposts, articles, connections, invitations, followed-companies, followed-people,
groups, saved-jobs, job-applications, job-preferences, job-postings, learning.
`;

const OPTIONS = {
  sections: { type: "string" },
  all: { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
  "all-items": { type: "boolean" },
  since: { type: "string" },
  refresh: { type: "boolean" },
  "no-cache": { type: "boolean" },
  compact: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`--limit must be a whole number of 1 or more, got "${value}".`);
  }
  return Number(value);
}

/** Options each command understands, on top of the global ones. Anything else is a usage error. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  profile: ["sections", "all"],
  section: ["limit", "cursor", "all-items"],
  activity: ["since", "limit", "cursor"],
  status: [],
  cache: [],
};
const GLOBAL_OPTIONS = ["refresh", "no-cache", "compact", "help", "version"];

/** Runs one CLI invocation and resolves with the process exit code. Never calls `process.exit`. */
export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl, maxRetries } = io;
  const fail = (error: Record<string, unknown>, code: number): number => {
    stderr.write(`${JSON.stringify(error)}\n`);
    return code;
  };

  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      if (argv.includes("--stdio")) {
        throw new UsageError("The --stdio flag was replaced by --mcp. Run: unlinked --mcp");
      }
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    const [command, ...rest] = positionals;

    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    if (values.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (command === undefined) {
      throw new UsageError("Missing command. Try: unlinked profile, section, activity, status, or --help.");
    }

    const print = (result: unknown) =>
      stdout.write(`${JSON.stringify(result, null, values.compact ? undefined : 2)}\n`);
    const cacheBase = io.cacheDir ?? defaultCacheDir({ env });

    const allowed = COMMAND_OPTIONS[command];
    if (allowed) {
      const stray = Object.keys(values).find((name) => !allowed.includes(name) && !GLOBAL_OPTIONS.includes(name));
      if (stray !== undefined) {
        throw new UsageError(`--${stray} does not apply to "${command}".`);
      }
    }

    // Validate everything that does not need LinkedIn first, so usage errors never depend on a token.
    type Job = (service: ReturnType<typeof createService>) => Promise<unknown>;
    let job: Job;
    switch (command) {
      case "profile": {
        if (rest.length > 0) {
          throw new UsageError(`Unexpected argument "${rest[0]}".`);
        }
        const sections = values.sections?.split(",").map((s) => s.trim()).filter(Boolean);
        if (sections?.length === 0) {
          throw new UsageError("--sections needs at least one section id, e.g. --sections experience,skills.");
        }
        if (values.all && sections !== undefined) {
          throw new UsageError("--all cannot be combined with --sections.");
        }
        resolveProfileSections({ sections, all: values.all });
        job = (service) => service.getProfile({ sections, all: values.all, refresh: values.refresh });
        break;
      }
      case "section": {
        if (rest.length !== 1) {
          throw new UsageError("Usage: unlinked section <id> [--limit N] [--cursor C] [--all-items]");
        }
        const section = resolveSection(rest[0]!).id;
        const limit = parseLimit(values.limit);
        if (values["all-items"] && (limit !== undefined || values.cursor !== undefined)) {
          throw new UsageError("--all-items cannot be combined with --limit or --cursor.");
        }
        checkCursor(values.cursor, section);
        job = (service) =>
          service.getSection({
            section,
            limit: values["all-items"] ? Number.POSITIVE_INFINITY : limit,
            cursor: values.cursor,
            refresh: values.refresh,
          });
        break;
      }
      case "activity": {
        if (rest.length > 0) {
          throw new UsageError(`Unexpected argument "${rest[0]}".`);
        }
        parseSince(values.since, Date.now());
        const limit = parseLimit(values.limit);
        checkCursor(values.cursor, "activity");
        job = (service) =>
          service.getRecentActivity({ since: values.since, limit, cursor: values.cursor, refresh: values.refresh });
        break;
      }
      case "status": {
        if (rest.length > 0) {
          throw new UsageError(`Unexpected argument "${rest[0]}".`);
        }
        job = (service) => service.checkAccess();
        break;
      }
      case "cache": {
        if (rest[0] !== "clear" || rest.length !== 1) {
          throw new UsageError("Usage: unlinked cache clear");
        }
        if (cacheBase !== undefined) {
          await clearAllDiskCache(cacheBase);
        }
        print({ cleared: true });
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}". Try: profile, section, activity, status, cache clear, or --help.`);
    }

    const config = readLinkedInRuntimeConfig(env);
    for (const warning of config.warnings) {
      stderr.write(`unlinked: warning: ${warning}\n`);
    }

    const cache = new Cache({
      token: config.accessToken,
      cacheDir: cacheBase,
      ttlMs: values["no-cache"] ? 0 : config.cacheTtlMs,
    });
    const client = new LinkedInClient({
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(maxRetries === undefined ? {} : { maxRetries }),
    });
    print(await job(createService({ client, cache, accessToken: config.accessToken })));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      return fail({ error: error.message }, 2);
    }
    if (error instanceof LinkedInApiError) {
      return fail(
        {
          error: error.message,
          ...(error.status > 0 ? { status: error.status } : {}),
          ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        },
        1,
      );
    }
    return fail({ error: error instanceof Error ? error.message : String(error) }, 1);
  }
}
