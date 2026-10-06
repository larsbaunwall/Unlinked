# AGENTS.md

## Project Purpose

This repository is **Unlinked**, a TypeScript MCP server that connects a user's LinkedIn professional profile and experience data to AI assistants such as Claude Desktop, GitHub Copilot, and other Model Context Protocol clients.

Unlinked exists to let a member bring their own professional context into an assistant without making the assistant scrape LinkedIn, infer profile details, or rely on stale manually copied text. The LinkedIn API surface used here is read-only.

Unlinked runs in two modes from one binary: a **JSON CLI** (the default: `unlinked profile`, `section`, `activity`, `status`, `cache clear`) and an **MCP server** (`unlinked --mcp`). Both are thin front ends over `src/service.ts`; keep behaviour in the service, not in the adapters (`src/cli.ts`, `src/tools/linkedin.ts`).

## Core Requirements

- Build the server with the official TypeScript MCP SDK, `@modelcontextprotocol/sdk`.
- Run the MCP server over stdio with `StdioServerTransport` when started with `--mcp`. Any other invocation is the CLI.
- Keep the project usable by desktop MCP clients, especially Claude Desktop and GitHub Copilot.
- Connect to LinkedIn's Member Data Portability (Member) API product.
- Fetch LinkedIn member profile and professional-history data for the authenticated member.
- Treat the LinkedIn access token as a startup secret. Read it from the `LINKEDIN_TOKEN` environment variable. Use it only to send `Authorization: Bearer <access_token>` to LinkedIn. Never persist it, log it, echo it into MCP responses or CLI output, or put it in package scripts. The cache directory name uses only a truncated sha256 of the token.
- **Bounded cache exception to "do not persist".** LinkedIn data is cached to protect the API: in memory for MCP, in memory plus disk for the CLI (`<OS cache dir>/unlinked/<sha256(token)[0:16]>/`, directory 0700, files 0600, atomic writes), 6 h TTL by default (`UNLINKED_CACHE_TTL`, `0` = off), empty results at most 10 minutes. Only sanitized data is ever cached: snapshot rows after `normalizeRow` redaction, and changelog events after dropping `messages`/`invitations` and keeping only the fields the merge and activity feed use. Blocked domains are never fetched. Errors are never cached. Tests assert that no cache file contains a redacted key, the token, or a LinkedIn domain name.
- Names match the LinkedIn UI. LinkedIn's internal domain names (`POSITIONS`, `ALL_LIKES`) live only in `src/linkedin/sections.ts` and never appear in tool descriptions or output.
- Sensitive domains (INBOX, LOGIN, PHONE_NUMBERS, EMAIL_ADDRESSES, CONTACTS, ads, searches, receipts, ...) are blocked in `sections.ts` and must never be fetched or exposed. Private fields inside exposed sections (birth date, address, contact emails/phones, ...) are redacted.
- Make clear in user-facing docs and errors that the Member Data Portability product is currently available only to LinkedIn members in the European Economic Area and Switzerland.
- Preserve the API's read-only nature. Do not add tools that mutate LinkedIn data.

## LinkedIn API Notes

The main documentation is LinkedIn's Microsoft Learn page for [Member Data Portability (Member)](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/?view=li-dma-data-portability-2025-11).

Before implementing or changing LinkedIn API behavior, also read the local skill at `.agents/skills/linkedin-member-data-portability/SKILL.md`.

Important behavior from the docs:

- Access requires a LinkedIn Developer application provisioned with the **Member Data Portability API (Member)** product.
- The OAuth Token Generator flow is currently available only to members located in the EEA and Switzerland.
- The token generator documentation currently instructs members to request the `r_dma_portability_self_serve` scope. The Snapshot and Changelog API pages also describe DMA portability permissions such as `r_dma_portability_member` and `r_dma_portability_3rd_party`. Follow the current docs and surface authorization failures clearly.
- The LinkedIn API version is pinned to `202312` (`Linkedin-Version` header). The API accepts no other version. `LINKEDIN_API_VERSION` is ignored; `config.ts` warns on stderr if it is set to anything else.
- Snapshot data is fetched with `GET https://api.linkedin.com/rest/memberSnapshotData?q=criteria` and optional `domain` query parameter.
- Professional profile domains to prioritize include `PROFILE`, `POSITIONS`, `EDUCATION`, `SKILLS`, `CERTIFICATIONS`, `PROJECTS`, `ORGANIZATIONS`, `LANGUAGES`, `HONORS`, `COURSES`, `PUBLICATIONS`, `PATENTS`, `VOLUNTEERING_EXPERIENCES`, and `RECOMMENDATIONS`.
- Snapshot responses may be paginated. Follow `paging.links` until no next page remains, and account for the docs' warning that `paging.total` may not fully reflect all pages.
- Changelog events are fetched with `GET https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication`. They cover events generated after member consent and are currently limited to the past 28 days.
- Changelog polling should support `startTime`, use the latest returned `processedAt` as the next cursor, default to modest page sizes, and respect the documented upper `count` limit of 50.
- LinkedIn errors use standard HTTP status codes and JSON bodies with `message`, `serviceErrorCode`, and `status`. Return helpful MCP errors without leaking tokens.

## MCP Design Guidance

- Prefer small, explicit tools with Zod input schemas and clear descriptions.
- Return useful `structuredContent` where practical so assistants can reliably consume profile data.
- Keep raw data available enough for transparency, but shape common outputs around professional profile context.
- Use tool inputs for request-shaping values such as requested domains, pagination limits, and start time. Do not require access tokens or API versions as per-tool inputs.
- Use `LINKEDIN_TOKEN` for token configuration. Do not put tokens in package scripts.
- In MCP mode, do not write to stdout except through the stdio transport. In CLI mode, stdout carries result JSON only. Diagnostics and errors always go to stderr (CLI errors are `{error, status?, requestId?}`; exit 1 for API/auth errors, 2 for usage errors).

Tools (thin adapters over `service.ts`):

- `linkedin_get_profile`: résumé sections with recent changes merged; larger sections come back as `related` links, never embedded.
- `linkedin_get_section`: one section, newest first, `limit` 1-200 (default 50), opaque `cursor` (base64 of `{offset, asOf}`; a cursor from before a refresh is rejected with "data changed, restart from first page").
- `linkedin_get_recent_activity`: the changelog as a flat feed (`since` accepts `7d`, an ISO date or epoch ms).
- `linkedin_check_access`: `{connected, trackingChangesSince?}` from `memberAuthorizations`.

Every result carries a `freshness` block (`asOf`, `recentChangesMerged`, `pendingEdits`, `empty`, `incomplete?`, `recentChangesError?`).

## Verified Facts (live API, probed 2026-10-05)

These come from the live API and override anything the docs suggest. Shapes only were inspected; no member data is committed.

- Only `Linkedin-Version: 202312` is accepted.
- Every snapshot page holds exactly one element `{snapshotDomain, snapshotData[]}`, and live every domain arrived on **one page** (`ALL_LIKES` 1,716 rows, `CONNECTIONS` 1,103). `paging.count` and `total` are meaningless. Keep following `next` links as a safety net (cap 50 pages).
- An empty or not-yet-ready domain returns **404** "No data found for this domain and memberId." That means "no entries" or "not prepared yet" (posts can take up to 24 h after consent). Only snapshot calls treat 404 as empty (a 404 on page 2+ ends the data and keeps earlier rows); changelog and authorization 404s are errors.
- `EVENTS` returns 400 "domain is not supported" even though the docs list it.
- Snapshot rows are flat export-style records with **no IDs**, with keys like `First Name`, `Company Name`, `ShareLink`, `Date/Time`, and sometimes an empty `""` key. Normalize to camelCase, drop empty values, de-duplicate.
- Snapshot `Date` values are `YYYY-MM-DD HH:MM:SS` in **UTC** and equal the changelog `capturedAt` to the second. Rows come newest-first.
- Reaction and comment `Link` values look like `https://www.linkedin.com/feed/update/<percent-encoded URN>`; a reaction on a comment adds `?commentUrn=urn:li:comment:(activity:N,M)`.
- Changelog: sorted by ascending `processedAt`, paged with `start`, `total` is 0. **There is no `processedActivity`; only `activity` exists.** Seen live: `people` PARTIAL_UPDATE (flat `{headline:{localized:{en_US}}, ...}`), `people/positions` PARTIAL_UPDATE, `socialActions/likes` CREATE, `socialActions/comments` CREATE, `invitations` ACTION (URNs only, no names), `messages` CREATE (inbox content, dropped).
- **The snapshot lags the changelog**, sometimes for more than 3 weeks (reactions on comments and a comment were missing from `ALL_LIKES`/`ALL_COMMENTS`). That is why changes are merged.
- Snapshot rows have no IDs and events carry no decoration, so `people/<collection>` edits (positions, ...) are never merged; a section is listed in `freshness.pendingEdits` only when an edited text value appears in no row (a value check, not a timestamp check).
- `ugcPosts` events have **not** been seen live; the posts merge follows the docs' UGC shape. **Verify the `ugcPosts` merge live once a post event is seen** (check the event shape, and that the post URN type, `share` vs `ugcPost`, de-duplicates against `MEMBER_SHARE_INFO`).
- ENDORSEMENTS rows are all endorsements the member **gave**. RECOMMENDATIONS `Status` is always empty, so given and received cannot be told apart.
- The UI sections Featured, profile photo/banner, and contact info beyond websites have no API data.

## Development Workflow

- Strict TDD: write a failing test first, then the minimal code. Tests use `node:test`, inject `fetchImpl`, use synthetic fixtures only, and never touch the network (`test/helpers/`).
- Use `npm test` for the suite, `npm run typecheck` (src and test), and `npm run build` (cleans `dist`, then compiles).
- Use `npm run dev -- profile` for local CLI development (pass `--mcp` to run the MCP server).
- Use `npm start` to run the compiled CLI.
- Use `npm run inspect` after `npm run build` to test the MCP server with MCP Inspector (it passes `--mcp`).
- The release workflow bumps the version; do not bump it by hand.
- The release workflow publishes to npm with **trusted publishing** (OIDC, with provenance), so it uses no npm token. One-time setup on npmjs.com: package `@larsbaunwall/unlinked` → Settings → Trusted Publisher → GitHub Actions, organization/user `larsbaunwall`, repository `Unlinked`, workflow filename `publish-mcp.yml`, no environment. The workflow needs Node 24 (npm 11.5.1+) and `permissions: id-token: write`; do not add an `NPM_TOKEN` secret or `NODE_AUTH_TOKEN`.
- Keep README examples short and friendly for people browsing the project on GitHub.
- Do not commit secrets, generated tokens, local MCP client config containing tokens, or captured LinkedIn member data.
