/** The only place that knows LinkedIn's internal domain names. Everything else uses UI section ids. */

export type SectionKind = "bounded" | "unbounded";
export type MergeKind = "intro" | "reactions" | "comments" | "posts";

export type SectionDef = {
  /** Stable id used in the CLI and MCP tools (kebab-case). */
  readonly id: string;
  /** Name as it appears in the LinkedIn UI. */
  readonly label: string;
  /** LinkedIn snapshot domain (internal, never exposed). */
  readonly domain: string;
  /** Bounded sections are small enough to embed in the profile; unbounded ones are paged. */
  readonly kind: SectionKind;
  /** True when the section is a single object rather than a list. */
  readonly single: boolean;
  /** Which changelog merge rule applies, if any. */
  readonly merge?: MergeKind;
  /** Normalized (camelCase) keys that are removed from every row. */
  readonly redactions: readonly string[];
  /** Normalized key renames applied after redaction. */
  readonly renames?: Readonly<Record<string, string>>;
  /** Part of the default `profile` output. */
  readonly isDefault?: boolean;
  /** Extra note for descriptions. */
  readonly note?: string;
};

type Spec = Omit<SectionDef, "kind" | "single" | "redactions"> &
  Partial<Pick<SectionDef, "kind" | "single" | "redactions">>;

const spec = (s: Spec): SectionDef => ({ kind: "bounded", single: false, redactions: [], ...s });
const unbounded = (s: Spec): SectionDef => spec({ ...s, kind: "unbounded" });

export const SECTIONS: readonly SectionDef[] = [
  spec({
    id: "intro",
    label: "Intro + About",
    domain: "PROFILE",
    single: true,
    merge: "intro",
    isDefault: true,
    redactions: ["address", "birthDate", "zipCode", "instantMessengers"],
    renames: { summary: "about" },
  }),
  spec({ id: "experience", label: "Experience", domain: "POSITIONS", isDefault: true }),
  spec({ id: "education", label: "Education", domain: "EDUCATION", isDefault: true }),
  spec({ id: "skills", label: "Skills", domain: "SKILLS", isDefault: true }),
  spec({ id: "certifications", label: "Licenses & certifications", domain: "CERTIFICATIONS", isDefault: true }),
  spec({ id: "projects", label: "Projects", domain: "PROJECTS", isDefault: true }),
  spec({ id: "languages", label: "Languages", domain: "LANGUAGES" }),
  spec({ id: "volunteering", label: "Volunteering", domain: "VOLUNTEERING_EXPERIENCES" }),
  spec({ id: "honors", label: "Honors & awards", domain: "HONORS" }),
  spec({ id: "courses", label: "Courses", domain: "COURSES" }),
  spec({ id: "publications", label: "Publications", domain: "PUBLICATIONS" }),
  spec({ id: "patents", label: "Patents", domain: "PATENTS" }),
  spec({ id: "test-scores", label: "Test scores", domain: "TEST_SCORES" }),
  spec({ id: "organizations", label: "Organizations", domain: "ORGANIZATIONS" }),
  spec({ id: "causes", label: "Causes", domain: "CAUSES_YOU_CARE_ABOUT" }),
  spec({
    id: "recommendations",
    label: "Recommendations",
    domain: "RECOMMENDATIONS",
    note: "Received and given are mixed; LinkedIn does not say which direction each one is.",
  }),
  spec({ id: "services", label: "Services", domain: "MARKETPLACE_PROVIDERS" }),
  unbounded({
    id: "endorsements-given",
    label: "Endorsements you gave",
    domain: "ENDORSEMENTS",
    note: "Rows name the person you endorsed, never you.",
  }),
  unbounded({ id: "posts", label: "Activity > Posts", domain: "MEMBER_SHARE_INFO", merge: "posts" }),
  unbounded({ id: "comments", label: "Activity > Comments", domain: "ALL_COMMENTS", merge: "comments" }),
  unbounded({ id: "reactions", label: "Activity > Reactions", domain: "ALL_LIKES", merge: "reactions" }),
  unbounded({ id: "reposts", label: "Activity > Reposts", domain: "INSTANT_REPOSTS" }),
  unbounded({ id: "articles", label: "Activity > Articles", domain: "ARTICLES" }),
  unbounded({ id: "connections", label: "My Network > Connections", domain: "CONNECTIONS", redactions: ["emailAddress"] }),
  unbounded({ id: "invitations", label: "My Network > Invitations", domain: "INVITATIONS" }),
  unbounded({ id: "followed-companies", label: "Interests > Companies", domain: "COMPANY_FOLLOWS" }),
  unbounded({ id: "followed-people", label: "Interests > People", domain: "MEMBER_FOLLOWING" }),
  unbounded({ id: "groups", label: "Interests > Groups", domain: "GROUPS" }),
  unbounded({ id: "saved-jobs", label: "Jobs > Saved", domain: "SAVED_JOBS" }),
  unbounded({
    id: "job-applications",
    label: "Jobs > Applied",
    domain: "JOB_APPLICATIONS",
    redactions: ["contactEmail", "contactPhoneNumber", "resumeName"],
  }),
  unbounded({
    id: "job-preferences",
    label: "Jobs > Preferences",
    domain: "JOB_SEEKER_PREFERENCES",
    redactions: [
      "phoneNumber",
      "commutePreferenceStartingAddress",
      "commutePreferenceStartingTime",
      "modeOfTransportation",
    ],
  }),
  unbounded({ id: "job-postings", label: "Jobs > Posted", domain: "JOB_POSTINGS" }),
  unbounded({ id: "learning", label: "LinkedIn Learning history", domain: "LEARNING" }),
];

export const RESUME_SECTIONS: readonly SectionDef[] = SECTIONS.filter((s) => s.kind === "bounded");
export const UNBOUNDED_SECTIONS: readonly SectionDef[] = SECTIONS.filter((s) => s.kind === "unbounded");
export const DEFAULT_PROFILE_SECTIONS: readonly SectionDef[] = SECTIONS.filter((s) => s.isDefault);

/** Sensitive domains that are never fetched, cached or exposed. Also EVENTS, which is unsupported. */
export const BLOCKED_DOMAINS: readonly string[] = [
  "INBOX",
  "LOGIN",
  "SECURITY_CHALLENGE_PIPE",
  "PHONE_NUMBERS",
  "EMAIL_ADDRESSES",
  "CONTACTS",
  "AD_TARGETING",
  "ADS_CLICKED",
  "ADS_LAN",
  "INFERENCE_TAKEOUT",
  "SEARCHES",
  "TRUSTED_GRAPH",
  "IDENTITY_CREDENTIALS_AND_ASSETS",
  "PREMIUM_NOTES",
  "RECEIPTS",
  "RECEIPTS_LBP",
  "REGISTRATION",
  "EASYAPPLY_BLOCKING",
  "LEARNING_COACH",
  "LEARNING_COACH_AI_TAKEOUT",
  "LEARNING_COACH_INBOX",
  "LEARNING_ROLEPLAY",
  "LEARNING_ROLEPLAY_INBOX",
  "EVENTS",
];

const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const BLOCKED = new Set(BLOCKED_DOMAINS.map(slug));
// EVENTS is unsupported rather than sensitive, so it is reported as unknown.
BLOCKED.delete("events");

export type SectionLookup =
  | { status: "found"; section: SectionDef }
  | { status: "blocked" }
  | { status: "unknown" };

export function lookupSection(name: string): SectionLookup {
  const key = slug(name);
  if (BLOCKED.has(key) || [...BLOCKED].some((blocked) => key.startsWith(`${blocked}-`))) {
    return { status: "blocked" };
  }
  const section = SECTIONS.find((s) => s.id === key);
  return section ? { status: "found", section } : { status: "unknown" };
}

/** "test-scores" -> "testScores". */
export function jsonKey(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
