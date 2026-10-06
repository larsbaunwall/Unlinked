// Preloaded with `node --import` into a child process so a real `unlinked` process can run with no network.
// Replaces globalThis.fetch with a synthetic LinkedIn. Mode comes from UNLINKED_STUB:
//   ok        every call succeeds (default)
//   flaky401  the first SKILLS snapshot request answers 401, later ones succeed
//   down      every request answers 503
//   denied    every request answers 401
// Every request is logged to stderr as "stub-fetch <path>" so tests can count them.
const mode = process.env.UNLINKED_STUB ?? "ok";
let skillsCalls = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  process.stderr.write(`stub-fetch ${url.pathname} ${url.searchParams.get("domain") ?? ""}\n`);
  if (url.host !== "api.linkedin.com") {
    return json(500, { message: "unexpected host" });
  }
  if (mode === "denied") {
    return json(401, { message: "Invalid access token" });
  }
  if (mode === "down") {
    return json(503, { message: "down" });
  }
  if (url.pathname === "/rest/memberSnapshotData") {
    const domain = url.searchParams.get("domain");
    if (domain === "SKILLS" && mode === "flaky401" && skillsCalls++ === 0) {
      return json(401, { message: "token expired" });
    }
    const rows = {
      PROFILE: [{ "First Name": "Ada", Headline: "Builder \u{1F680}", "Birth Date": "Jan 1" }],
      SKILLS: [{ Name: "TypeScript" }, { Name: "Rüst" }],
      ALL_LIKES: Array.from({ length: 5 }, (_, i) => ({
        Date: `2026-09-1${i} 10:00:00`,
        Type: "LIKE",
        Link: `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${7000000000000 + i}`,
      })),
    }[domain ?? ""];
    return rows
      ? json(200, { elements: [{ snapshotDomain: domain, snapshotData: rows }], paging: { links: [] } })
      : json(404, { message: "No data found for this domain and memberId.", status: 404 });
  }
  if (url.pathname === "/rest/memberChangeLogs") {
    return json(200, { elements: [], paging: { links: [] } });
  }
  if (url.pathname === "/rest/memberAuthorizations") {
    return json(200, { elements: [{ regulatedAt: 1790000000000 }] });
  }
  return json(500, { message: "unexpected path" });
};
