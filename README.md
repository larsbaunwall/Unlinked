# <img src="logo.png" alt="Unlinked logo" width="40" /> Unlinked

Your LinkedIn profile, up to date, in one call. From your terminal or from your AI assistant.

---

Unlinked reads your own data from LinkedIn's official [Member Data Portability API](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/) and hands it over as tidy JSON. It works two ways:

- **CLI**: `unlinked profile` prints your profile as JSON.
- **MCP server**: `unlinked --mcp` gives [Model Context Protocol](https://modelcontextprotocol.io/) clients such as Claude Desktop and GitHub Copilot four read-only tools.

LinkedIn's data export can lag behind what you just did. Unlinked also reads your recent changes (the last 28 days) and merges them in, so a headline you edited yesterday or a comment you wrote last week is already there.

> :eu: **EEA / Switzerland only.** LinkedIn's Member Data Portability API is currently available only to members located in the European Economic Area and Switzerland. Thank you, Digital Markets Act (DMA)!

> :warning: **Use at your own risk.** You use Unlinked entirely on your own responsibility. See the [Disclaimer](#disclaimer).

## Quickstart

You need Node.js 22+ and a [member access token](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/?view=li-dma-data-portability-2025-11#getting-an-access-token) from the LinkedIn OAuth Token Generator (it requires a LinkedIn Developer app with the **Member Data Portability API (Member)** product).

```bash
LINKEDIN_TOKEN=<your_access_token> npx -y @larsbaunwall/unlinked profile
```

```bash
unlinked profile                          # résumé: intro, experience, education, skills, certifications, projects
unlinked profile --sections skills,languages
unlinked profile --all                    # every résumé section
unlinked section reactions --limit 20     # one section, a page at a time, newest first
unlinked section posts --all-items        # everything in a section, for exports
unlinked activity --since 7d              # what changed recently
unlinked status                           # is LinkedIn sharing recent changes with this app?
unlinked cache clear
```

Results are JSON on stdout (use `--compact` for one line). Errors are JSON on stderr, with exit code 1 for LinkedIn or token problems and 2 for usage mistakes such as an unknown section.

## Use it from an AI assistant

Add `--mcp` so Unlinked runs as an MCP server.

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "unlinked": {
      "command": "npx",
      "args": ["-y", "@larsbaunwall/unlinked", "--mcp"],
      "env": {
        "LINKEDIN_TOKEN": "<your_access_token>"
      }
    }
  }
}
```

The config file is typically at:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### GitHub Copilot (VS Code)

Add to your user-level MCP config or a workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "unlinked": {
      "command": "npx",
      "args": ["-y", "@larsbaunwall/unlinked", "--mcp"],
      "env": {
        "LINKEDIN_TOKEN": "<your_access_token>"
      }
    }
  }
}
```

### Tools

| Tool | What it does |
| --- | --- |
| `linkedin_get_profile` | Your résumé in one call, with recent edits included. Larger sections come back as links. |
| `linkedin_get_section` | One section, a page at a time (`limit` 1-200, default 50, plus `cursor`). |
| `linkedin_get_recent_activity` | What changed in the last 28 days: profile edits, posts, comments, reactions. |
| `linkedin_check_access` | Whether LinkedIn is sharing recent changes with this app. |

All four are read-only. Each returns structured JSON plus a one-line summary.

## Sections

Sections use the names you see on LinkedIn. `profile` embeds the small ones; the big ones (marked paged) are fetched with `section <id>`.

| Section id | On LinkedIn | Notes |
| --- | --- | --- |
| `intro` | Intro + About | In the default profile |
| `experience` | Experience | In the default profile |
| `education` | Education | In the default profile |
| `skills` | Skills | In the default profile |
| `certifications` | Licenses & certifications | In the default profile |
| `projects` | Projects | In the default profile |
| `languages`, `volunteering`, `honors`, `courses`, `publications`, `patents`, `test-scores`, `organizations`, `causes`, `services` | Languages, Volunteering, Honors & awards, Courses, Publications, Patents, Test scores, Organizations, Causes, Services | With `profile --all` |
| `recommendations` | Recommendations | With `profile --all`. Received and given are mixed; LinkedIn does not say which is which |
| `posts`, `comments`, `reactions`, `reposts`, `articles` | Activity | Paged. Recent posts, comments and reactions are merged in |
| `connections`, `invitations` | My Network | Paged. Email addresses are removed |
| `followed-companies`, `followed-people`, `groups` | Interests | Paged |
| `saved-jobs`, `job-applications`, `job-preferences`, `job-postings` | Jobs | Paged. Contact details and addresses are removed |
| `endorsements-given` | Endorsements you gave | Paged |
| `learning` | LinkedIn Learning history | Paged |

Sensitive data is never read: messages, login history, phone numbers, email addresses, contacts, ads, searches, receipts and similar. Private details inside the sections above (birth date, home address and so on) are removed.

**Featured, your profile photo and banner, and contact info (beyond websites) are not in LinkedIn's API**, so Unlinked cannot return them.

## Freshness and cache

Every answer has a `freshness` block: when the data was fetched (`asOf`), how many recent changes were merged in, which sections have edits LinkedIn's export does not show yet (`pendingEdits`), and which came back empty.

An **empty section** has two possible meanings: you have no entries there, or LinkedIn has not prepared it yet (new data can take up to 24 hours after you first grant consent).

To be kind to LinkedIn's API, results are cached for up to 6 hours. The CLI keeps the cache in your OS cache folder (readable only by you, never containing your token); the MCP server keeps it in memory only.

```bash
unlinked profile --refresh     # fetch fresh data now
unlinked profile --no-cache    # do not read or write the cache
unlinked cache clear           # delete the cached files
UNLINKED_CACHE_TTL=30m         # change the lifetime (30m, 2h, 1d, or 0 for off)
```

## Configuration

| Environment variable | Required | Description |
| --- | --- | --- |
| `LINKEDIN_TOKEN` | Yes | LinkedIn access token. Accepts `Bearer <token>` or a bare token. |
| `UNLINKED_CACHE_TTL` | No | Cache lifetime: `30m`, `2h`, `1d`, or `0` to turn it off. Defaults to `6h`. |

`LINKEDIN_API_VERSION` is no longer used. LinkedIn accepts only version `202312` for this API, so Unlinked always sends that and warns on stderr if the variable is set to anything else.

## Upgrading from 1.x

2.0 is a breaking release.

- **MCP configs need `--mcp`** in `args`. Without it Unlinked runs as a CLI and exits.
- Five tools became four: `linkedin_get_profile`, `linkedin_get_section`, `linkedin_get_recent_activity` and `linkedin_check_access`. `linkedin_get_activity`, `linkedin_get_recent_changes` and the `domain`/`maxPages` inputs are gone.
- Sections use LinkedIn's UI names (`experience`, `reactions`) instead of internal ones (`POSITIONS`, `ALL_LIKES`), and rows use camelCase keys without empty values.
- Recent changes are merged into the data for you; there is no `startTime` polling.
- Sensitive sections are blocked, and private fields are removed.

## Security

- **Treat tool output as untrusted data.** Sections such as recommendations you received, invitation messages, and connection names and headlines contain text written by other people. An assistant should read it as data and never follow instructions found in it (prompt injection).
- **The disk cache is plaintext.** The CLI cache (up to 6 hours, readable only by you) holds your profile plus connections, invitations and job-application data, unencrypted. Your token is never written to it. Run `unlinked cache clear` to remove it. The MCP server keeps its cache in memory only.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run dev -- profile   # run from source with .env
npm run inspect          # try the MCP server in MCP Inspector (build first)
```

See [AGENTS.md](AGENTS.md) for implementation guidance.

## Disclaimer

**Use of Unlinked is at your sole risk and responsibility.**

Unlinked is provided "as is" and "as available", without warranty of any kind, express or implied. It is an independent, unofficial open-source project. It is not affiliated with, endorsed by, or sponsored by the developer.

By installing or using Unlinked, you accept that:

- **You are solely responsible** for how you use it and for everything that follows from that use. This includes your LinkedIn access token and its storage, the data you retrieve, the local cache on your machine, and the AI assistants, MCP clients, and third-party services you give that data to.
- **You are responsible for compliance** with LinkedIn's terms, policies, and API product terms, with applicable laws (including data protection law such as the GDPR), and with the terms of any AI assistant or service you connect. Your LinkedIn account and API access may be limited, suspended, or terminated by LinkedIn.
- **You bear all risk** of loss, damage, or harm of any kind, including loss or exposure of data, account restrictions, incorrect or outdated output, and actions taken by AI assistants based on that output.
- **The developer and contributors accept no liability** and, to the fullest extent permitted by law, disclaim all liability for any claim, damage, or loss, whether direct, indirect, incidental, special, consequential, or otherwise, and whether in contract, tort, or otherwise, arising from or in connection with Unlinked or its use. You release them from any such claim and agree to indemnify and hold them harmless against any claim brought by a third party that arises from your use of Unlinked.

Nothing in this notice limits any liability that cannot be excluded under applicable law. This notice supplements the [MIT License](LICENSE), which also applies.

## License

MIT
