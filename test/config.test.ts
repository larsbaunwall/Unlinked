import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readLinkedInRuntimeConfig } from "../src/linkedin/config.js";

const TOKEN = "synthetic-secret-token-value";

describe("readLinkedInRuntimeConfig", () => {
  test("a missing token is a clear error", () => {
    assert.throws(() => readLinkedInRuntimeConfig({}), /Missing LinkedIn token.*LINKEDIN_TOKEN/);
    assert.throws(() => readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: "   " }), /Missing LinkedIn token/);
  });

  test("accepts a bare or Bearer-prefixed token", () => {
    assert.equal(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN }).accessToken, TOKEN);
    assert.equal(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: `Bearer ${TOKEN}` }).accessToken, TOKEN);
  });

  test("LINKEDIN_API_VERSION is ignored; anything but 202312 earns a warning", () => {
    assert.deepEqual(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN }).warnings, []);
    assert.deepEqual(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN, LINKEDIN_API_VERSION: "202312" }).warnings, []);
    const { warnings } = readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN, LINKEDIN_API_VERSION: "202501" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /LINKEDIN_API_VERSION.*ignored.*202312/);
  });

  test("UNLINKED_CACHE_TTL sets the cache lifetime; an invalid value warns and falls back to 6h", () => {
    const read = (ttl?: string) => readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN, ...(ttl === undefined ? {} : { UNLINKED_CACHE_TTL: ttl }) });
    assert.equal(read().cacheTtlMs, 6 * 3_600_000);
    assert.equal(read("30m").cacheTtlMs, 1_800_000);
    assert.equal(read("0").cacheTtlMs, 0);
    assert.deepEqual(read("30m").warnings, []);
    const bad = read("banana");
    assert.equal(bad.cacheTtlMs, 6 * 3_600_000);
    assert.match(bad.warnings[0]!, /UNLINKED_CACHE_TTL.*banana/);
  });

  test("the Bearer prefix is accepted in any case and with any whitespace after it", () => {
    for (const prefix of ["bearer ", "BEARER ", "Bearer   ", "Bearer\t"]) {
      assert.equal(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: `${prefix}${TOKEN}` }).accessToken, TOKEN, JSON.stringify(prefix));
    }
  });

  test("surrounding whitespace and newlines from .env quirks are trimmed", () => {
    assert.equal(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: `  ${TOKEN}\n` }).accessToken, TOKEN);
    assert.equal(readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: `\r\nBearer ${TOKEN}\r\n` }).accessToken, TOKEN);
  });

  test("a bare Bearer prefix is a missing token, not a token called Bearer", () => {
    for (const value of ["Bearer", "Bearer ", "bearer   ", "Bearer\n"]) {
      assert.throws(() => readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: value }), /Missing LinkedIn token/, JSON.stringify(value));
    }
  });

  test("a token with inner whitespace or non-ASCII characters is rejected without echoing it", () => {
    for (const value of ["abc-secret def-secret", "abc-secret\ndef-secret", "abc-secrét", "abc-secret\u0000x"]) {
      assert.throws(
        () => readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: value }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /LINKEDIN_TOKEN/);
          assert.ok(!error.message.includes("abc-secret"), error.message);
          return true;
        },
        JSON.stringify(value),
      );
    }
  });

  test("a token pasted into the wrong variable is not echoed back in a warning", () => {
    const version = readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN, LINKEDIN_API_VERSION: TOKEN });
    assert.equal(version.warnings.length, 1);
    assert.match(version.warnings[0]!, /LINKEDIN_API_VERSION=\[token\] is ignored/);
    assert.ok(!version.warnings[0]!.includes(TOKEN));

    const ttl = readLinkedInRuntimeConfig({ LINKEDIN_TOKEN: TOKEN, UNLINKED_CACHE_TTL: `${TOKEN}h` });
    assert.equal(ttl.warnings.length, 1);
    assert.match(ttl.warnings[0]!, /UNLINKED_CACHE_TTL=\[token\]h is not valid/);
    assert.ok(!ttl.warnings[0]!.includes(TOKEN));
  });
});
