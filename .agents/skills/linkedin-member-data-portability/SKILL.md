---
name: linkedin-member-data-portability
description: "Use when: implementing, reviewing, or documenting LinkedIn Member Data Portability API calls for the Unlinked MCP server, including snapshot domains, changelog events, access-token handling, EEA availability, and read-only profile data tools."
---

# LinkedIn Member Data Portability API

Use this skill whenever you implement or review LinkedIn API behavior for Unlinked.

## Product Context

Unlinked uses LinkedIn's **Member Data Portability (Member)** API product. The purpose is to let a LinkedIn member connect their own professional profile and experience data to an AI assistant through a local MCP server. The API is read-only for this project.

This API product exists for DMA data portability and is currently available only to LinkedIn members located in the European Economic Area and Switzerland. User-facing setup and error messages should say this plainly.

## Access And Tokens

- A LinkedIn Developer application must be provisioned with **Member Data Portability API (Member)**.
- LinkedIn's OAuth Token Generator docs currently instruct users to request `r_dma_portability_self_serve` for member self-serve access.
- Snapshot and changelog docs also reference `r_dma_portability_member` and `r_dma_portability_3rd_party` permissions. Treat 403 responses as likely product/scope/consent problems and explain that clearly.
- The access token comes from the `LINKEDIN_TOKEN` environment variable (never a tool input). Send it only as `Authorization: Bearer <access_token>` to LinkedIn.
- Never store, log, return, or include access tokens in thrown errors, CLI output or cache files.
- LinkedIn data (not the token) is cached for a bounded time (default 6 h, memory for MCP, memory plus owner-only disk files for the CLI). Cache only sanitized data: redacted, normalized snapshot rows and cleaned changelog events. See AGENTS.md.

## Required Headers

Every LinkedIn REST call should include:

```http
Authorization: Bearer <access_token>
Linkedin-Version: <YYYYMM>
Content-Type: application/json
```

Use the exact header name `Linkedin-Version`. The version is **pinned to `202312`**: live, no other value is accepted, even though the docs have newer versions. Do not make it configurable.

## Snapshot API

Use the Snapshot API for profile and professional-history data.

```http
GET https://api.linkedin.com/rest/memberSnapshotData?q=criteria
GET https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=PROFILE
```

The optional `domain` query parameter is case-sensitive. If omitted, LinkedIn may return all domains. Prefer explicit domains for predictable assistant-facing tools.

Important response behavior:

- `elements` contains snapshot records with `snapshotDomain` and `snapshotData`.
- `snapshotData` is a list of data generated for the requested domain.
- Responses can be paginated with `paging.links` entries whose `rel` is `next` or `prev`.
- Do not trust `paging.total` as a complete page count; the docs say offline systems can make it incomplete.
- Follow next links until there is no next page or until a safety cap (50 pages) is reached.

Verified live (2026-10-05), overriding the docs where they differ:

- Every page has exactly one element `{snapshotDomain, snapshotData[]}`, and every domain arrived on **one page** (1,716 `ALL_LIKES` rows). `paging.count` and `total` are meaningless.
- An empty or not-yet-ready domain returns **404** "No data found for this domain and memberId." Treat it as empty for snapshot calls only (a 404 on page 2+ ends the data and keeps earlier rows). Posts can take up to 24 h to appear after first consent.
- `EVENTS` returns 400 "domain is not supported" although documented. Never request it.
- Rows are flat export-style records with **no IDs** and keys like `First Name`, `ShareLink`, `Date/Time` (sometimes an empty `""` key). Normalize to camelCase, drop empty values, de-duplicate.
- `Date` is `YYYY-MM-DD HH:MM:SS` in UTC, equal to the changelog `capturedAt`. Rows are newest-first.
- Reaction and comment `Link` values are `https://www.linkedin.com/feed/update/<percent-encoded URN>`; a reaction on a comment adds `?commentUrn=urn:li:comment:(activity:N,M)`.
- The snapshot **lags the changelog**, sometimes by more than 3 weeks, which is why Unlinked merges recent events into reactions, comments, posts and the intro.
- ENDORSEMENTS rows are endorsements the member gave. RECOMMENDATIONS `Status` is always empty (direction unknown).
- Featured, profile photo/banner and contact info beyond websites have no API data.

Professional-context domains to prioritize:

- `PROFILE`: basic biographical profile information.
- `POSITIONS`: job roles, companies, titles, descriptions, locations, and dates.
- `EDUCATION`: schools, dates, degrees, and activities.
- `SKILLS`: skills added to the member profile.
- `CERTIFICATIONS`: certifications on the profile.
- `PROJECTS`: projects listed on the profile.
- `LANGUAGES`: languages and proficiency.
- `HONORS`: honors listed on the profile.
- `COURSES`: courses listed on the profile.
- `PUBLICATIONS`: publications listed on the profile.
- `PATENTS`: patents listed on the profile.
- `ORGANIZATIONS`: organizations listed on the profile.
- `VOLUNTEERING_EXPERIENCES`: volunteering roles and descriptions.
- `RECOMMENDATIONS`: recommendations received and given.

Other useful domains include `CONNECTIONS`, `MEMBER_SHARE_INFO`, `ARTICLES`, `ALL_COMMENTS`, `ALL_LIKES`, `JOB_APPLICATIONS`, `JOB_POSTINGS`, `SAVED_JOBS`, `JOB_SEEKER_PREFERENCES`, and `PROFILE_SUMMARY`. Be thoughtful before exposing broad activity or inbox-like domains by default because they may contain sensitive personal data.

## Changelog API

Use the Changelog API for recent post-consent activity events.

```http
GET https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication
GET https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication&startTime=<epoch_ms>&count=10
```

Behavior to preserve:

- Events are available for up to the past 28 days.
- `startTime` is an inclusive epoch-millisecond timestamp.
- Invalid timestamps return `400`.
- The docs recommend `count=10`; the upper limit is `50`.
- Use the latest returned `processedAt` as the next `startTime` cursor. If no event is returned, keep the same cursor for the next poll.
- `capturedAt` is the recommended event activity time when embedded activity timestamps are missing.
- Changelog records include fields such as `id`, `capturedAt`, `processedAt`, `owner`, `actor`, `resourceName`, `resourceId`, `resourceUri`, `method`, `activity`, `activityId`, and `activityStatus`. **Live there is no `processedActivity`; only `activity` exists**, so read `activity` (unwrap `patch.$set` if present).
- Results are sorted by ascending `processedAt` and paged with `start`; `total` is 0 (meaningless). Clamp `count` to 1..50. A 404 here is an error, not "empty".
- Resources seen live: `people` (PARTIAL_UPDATE), `people/positions` (PARTIAL_UPDATE), `socialActions/likes` and `socialActions/comments` (CREATE), `invitations` (ACTION, URNs only), `messages` (inbox content: drop it). `ugcPosts` has not been seen live; its shape comes from the docs. **Verify the `ugcPosts` merge live once a post event is seen.**
- Group by `activityId`, keep the last non-FAILURE record (FAILURE can be followed by SUCCESSFUL_REPLAY).

## Authorization Status API

The changelog management API can check whether changelog generation is active:

```http
GET https://api.linkedin.com/rest/memberAuthorizations?q=memberAndApplication
```

There is also a documented activation endpoint:

```http
POST https://api.linkedin.com/rest/memberAuthorizations
Content-Type: application/json

{}
```

Unlinked should stay read-only by default. Do not add the POST activation behavior unless the project explicitly decides that this consent-management call is acceptable and documents it as separate from LinkedIn profile data mutation.

## Error Handling

LinkedIn error bodies typically contain:

```json
{
  "message": "Empty oauth2_access_token",
  "serviceErrorCode": 401,
  "status": 401
}
```

Map common failures into helpful MCP errors:

- `400`: invalid query, timestamp, count, domain, or request syntax.
- `401`: missing, expired, revoked, invalid, or malformed bearer token.
- `403`: application lacks product access, scope, or member consent.
- `404`: endpoint or restricted API issue.
- `426`: API version header is deprecated.
- `429`: rate limit; reduce duplicate calls and retry later.
- `500` or `504`: LinkedIn-side failure or timeout; include request id headers when available, but never include tokens.

## MCP Implementation Notes

- Unlinked is dual mode: a JSON CLI by default, and an MCP server with `--mcp`. Both are thin adapters over `src/service.ts`.
- Use `McpServer` and `StdioServerTransport` from `@modelcontextprotocol/sdk`.
- Name things as the LinkedIn UI does (`experience`, `reactions`); internal domain names live only in `src/linkedin/sections.ts`. Sensitive domains are blocked there.
- Use Zod schemas for inputs and outputs. Return both a one-line text summary plus JSON in `content` and machine-readable `structuredContent`; failures return `isError: true`.
- Write diagnostics to stderr only. In MCP mode stdout belongs to the transport; in CLI mode it carries result JSON only.
- Keep the token in memory only; never in cache files, logs or output.
- Keep payloads bounded: only small résumé sections are embedded in `profile`; large sections are paged with cursors.
