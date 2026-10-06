import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRow } from "../src/linkedin/normalize.js";
import {
  RESUME_SECTIONS,
  SECTIONS,
  UNBOUNDED_SECTIONS,
  jsonKey,
  BLOCKED_DOMAINS,
  lookupSection,
} from "../src/linkedin/sections.js";

describe("section table", () => {
  test("ids, labels and domains are unique and non-empty", () => {
    for (const field of ["id", "label", "domain"] as const) {
      const values = SECTIONS.map((s) => s[field]);
      assert.ok(values.every(Boolean));
      assert.equal(new Set(values).size, values.length, field);
    }
  });

  test("bounded sections are the resume set and never include activity or network data", () => {
    const ids = RESUME_SECTIONS.map((s) => s.id);
    for (const id of ["intro", "experience", "skills", "languages", "recommendations", "publications"]) {
      assert.ok(ids.includes(id), id);
    }
    for (const id of ["posts", "comments", "reactions", "connections", "invitations", "endorsements-given", "learning"]) {
      assert.ok(!ids.includes(id), id);
      assert.ok(UNBOUNDED_SECTIONS.some((s) => s.id === id), id);
    }
    assert.deepEqual(ids, [
      "intro", "experience", "education", "skills", "certifications", "projects", "languages", "volunteering", "honors",
      "courses", "publications", "patents", "test-scores", "organizations", "causes", "recommendations", "services",
    ]);
    assert.deepEqual(UNBOUNDED_SECTIONS.map((s) => s.id), [
      "endorsements-given", "posts", "comments", "reactions", "reposts", "articles", "connections", "invitations",
      "followed-companies", "followed-people", "groups", "saved-jobs", "job-applications", "job-preferences", "job-postings", "learning",
    ]);
  });

  test("labels and notes are the names shown on LinkedIn", () => {
    assert.deepEqual(
      SECTIONS.map((s) => [s.id, s.label]),
      [
        ["intro", "Intro + About"], ["experience", "Experience"], ["education", "Education"], ["skills", "Skills"],
        ["certifications", "Licenses & certifications"], ["projects", "Projects"], ["languages", "Languages"],
        ["volunteering", "Volunteering"], ["honors", "Honors & awards"], ["courses", "Courses"], ["publications", "Publications"],
        ["patents", "Patents"], ["test-scores", "Test scores"], ["organizations", "Organizations"], ["causes", "Causes"],
        ["recommendations", "Recommendations"], ["services", "Services"], ["endorsements-given", "Endorsements you gave"],
        ["posts", "Activity > Posts"], ["comments", "Activity > Comments"], ["reactions", "Activity > Reactions"],
        ["reposts", "Activity > Reposts"], ["articles", "Activity > Articles"], ["connections", "My Network > Connections"],
        ["invitations", "My Network > Invitations"], ["followed-companies", "Interests > Companies"],
        ["followed-people", "Interests > People"], ["groups", "Interests > Groups"], ["saved-jobs", "Jobs > Saved"],
        ["job-applications", "Jobs > Applied"], ["job-preferences", "Jobs > Preferences"], ["job-postings", "Jobs > Posted"],
        ["learning", "LinkedIn Learning history"],
      ],
    );
    assert.deepEqual(
      SECTIONS.filter((s) => s.note !== undefined).map((s) => [s.id, s.note]),
      [
        ["recommendations", "Received and given are mixed; LinkedIn does not say which direction each one is."],
        ["endorsements-given", "Rows name the person you endorsed, never you."],
      ],
    );
  });

});

describe("redaction (live-shaped rows)", () => {
  const redact = (id: string, row: Record<string, unknown>) => normalizeRow(row, SECTIONS.find((s) => s.id === id)!.redactions);

  test("intro drops address, birth date, zip code and instant messengers but keeps the rest", () => {
    const row = {
      "First Name": "Ada", "Last Name": "Synthetic", "Maiden Name": "", Address: "1 Fake St", "Birth Date": "Jan 1",
      Headline: "Builder", Summary: "About", Industry: "Software", "Zip Code": "00000", "Geo Location": "Copenhagen",
      "Twitter Handles": "@ada", Websites: "https://example.com", "Instant Messengers": "ada@im",
    };
    assert.deepEqual(redact("intro", row), {
      firstName: "Ada", lastName: "Synthetic", headline: "Builder", summary: "About", industry: "Software",
      geoLocation: "Copenhagen", twitterHandles: "@ada", websites: "https://example.com",
    });
  });

  test("connections drop the e-mail address", () => {
    assert.deepEqual(redact("connections", { "First Name": "Bo", URL: "https://x", "Email Address": "bo@example.com", Company: "X" }), {
      firstName: "Bo", url: "https://x", company: "X",
    });
  });

  test("job applications drop contact details and the résumé name", () => {
    const row = { "Company Name": "Y", "Job Title": "Eng", "Contact Email": "a@b.c", "Contact Phone Number": "123", "Resume Name": "cv.pdf", "Application Date": "2026-09-01" };
    assert.deepEqual(redact("job-applications", row), { companyName: "Y", jobTitle: "Eng", applicationDate: "2026-09-01" });
  });

  test("job preferences drop phone number and commute details", () => {
    const row = {
      "Phone Number": "123", "Commute Preference Starting Address": "1 Fake St", "Commute Preference Starting Time": "08:00",
      "Mode Of Transportation": "bike", "Preferred Locations": "Copenhagen",
    };
    assert.deepEqual(redact("job-preferences", row), { preferredLocations: "Copenhagen" });
  });

  test("no section reads a domain that is on the blocked list", () => {
    const blocked = new Set(BLOCKED_DOMAINS);
    for (const section of SECTIONS) {
      assert.ok(!blocked.has(section.domain), section.domain);
    }
  });
});

describe("jsonKey", () => {
  test("camelCases multi-word ids", () => {
    assert.equal(jsonKey("test-scores"), "testScores");
    assert.equal(jsonKey("endorsements-given"), "endorsementsGiven");
    assert.equal(jsonKey("skills"), "skills");
  });
});

describe("lookupSection", () => {
  test("finds sections by id, case-insensitively", () => {
    const result = lookupSection("Experience");
    assert.equal(result.status, "found");
    assert.equal(result.status === "found" && result.section.domain, "POSITIONS");
  });

  test("blocks sensitive sections under any spelling", () => {
    for (const name of ["inbox", "INBOX", "login", "security_challenge_pipe", "phone-numbers", "Email Addresses", "ad_targeting", "searches", "learning_coach_ai_takeout", "LEARNING_COACH_INBOX", "learning-roleplay-inbox"]) {
      assert.equal(lookupSection(name).status, "blocked", name);
    }
  });

  test("LinkedIn internal names and unsupported sections are unknown", () => {
    for (const name of ["POSITIONS", "EVENTS", "nonsense", ""]) {
      assert.equal(lookupSection(name).status, "unknown", name);
    }
  });
});
