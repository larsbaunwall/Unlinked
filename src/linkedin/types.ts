export const LINKEDIN_API_BASE_URL = "https://api.linkedin.com";
/** The only version the Member Data Portability API accepts. */
export const LINKEDIN_API_VERSION = "202312";
export type JsonObject = Record<string, unknown>;

export type LinkedInAuth = {
  accessToken: string;
};

export type SnapshotDomainResult = {
  domain: string;
  snapshotData: unknown[];
  rawElements: unknown[];
  pageCount: number;
  truncated: boolean;
  /** True when LinkedIn answered 404 for the first page: no entries, or not prepared yet. */
  empty: boolean;
};

export type ChangelogResult = {
  events: unknown[];
  nextStartTime?: number;
  pageCount: number;
  truncated: boolean;
};

export type AuthorizationStatusResult = JsonObject;