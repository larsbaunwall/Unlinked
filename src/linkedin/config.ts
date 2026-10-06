import { parseCacheTtl } from "../cache.js";
import { LINKEDIN_API_VERSION } from "./types.js";

export const LINKEDIN_TOKEN_ENV = "LINKEDIN_TOKEN";
export const LINKEDIN_API_VERSION_ENV = "LINKEDIN_API_VERSION";
export const CACHE_TTL_ENV = "UNLINKED_CACHE_TTL";

export type LinkedInRuntimeConfig = {
  accessToken: string;
  /** Cache lifetime in milliseconds (0 = off). */
  cacheTtlMs: number;
  /** Human-readable configuration warnings for stderr. Never contain the token. */
  warnings: string[];
};

export function readLinkedInRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LinkedInRuntimeConfig {
  const accessToken = readAccessToken(env);
  if (!accessToken) {
    throw new Error(
      `Missing LinkedIn token. Set ${LINKEDIN_TOKEN_ENV}=<access_token> before running Unlinked.`,
    );
  }

  if (!/^[\x21-\x7E]+$/.test(accessToken)) {
    throw new Error(
      `${LINKEDIN_TOKEN_ENV} contains spaces, line breaks or non-ASCII characters. Paste the access token on its own, without quotes or extra text.`,
    );
  }

  const warnings: string[] = [];
  // A token pasted into the wrong variable must not come back out in a warning.
  const warn = (text: string) => warnings.push(text.split(accessToken).join("[token]"));
  const apiVersion = readNonEmptyEnv(env, LINKEDIN_API_VERSION_ENV);
  if (apiVersion !== undefined && apiVersion !== LINKEDIN_API_VERSION) {
    warn(
      `${LINKEDIN_API_VERSION_ENV}=${apiVersion} is ignored: LinkedIn's Member Data Portability API only accepts ${LINKEDIN_API_VERSION}.`,
    );
  }

  const ttlText = readNonEmptyEnv(env, CACHE_TTL_ENV);
  const ttl = parseCacheTtl(ttlText);
  if (!ttl.valid) {
    warn(`${CACHE_TTL_ENV}=${ttlText} is not valid (use 30m, 2h, 1d or 0); using the 6h default.`);
  }

  return { accessToken, cacheTtlMs: ttl.ttlMs, warnings };
}

function readAccessToken(env: NodeJS.ProcessEnv): string | undefined {
  const value = readNonEmptyEnv(env, LINKEDIN_TOKEN_ENV);
  if (!value) {
    return undefined;
  }

  // "Bearer <token>" is accepted; a lone "Bearer" means no token was pasted.
  if (/^bearer(\s|$)/i.test(value)) {
    return value.replace(/^bearer\s*/i, "").trim() || undefined;
  }

  return value;
}

function readNonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}
