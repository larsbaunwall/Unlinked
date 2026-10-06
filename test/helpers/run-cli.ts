import { runCli } from "../../src/cli.js";
import { linkedinFake, type LinkedInFakeOptions } from "./linkedin-fake.js";
import { tempDir } from "./temp-dir.js";

export const TOKEN = "synthetic-secret-token-value";

export type RunOptions = {
  env?: NodeJS.ProcessEnv;
  fake?: LinkedInFakeOptions;
  cacheDir?: string;
  /** Replaces the LinkedIn fake entirely (for transport-level failures). */
  fetchImpl?: typeof fetch;
};

/** Runs the CLI in-process against a fake LinkedIn and captures both streams. */
export async function run(argv: string[], { env = { LINKEDIN_TOKEN: TOKEN }, fake: fakeOptions = {}, cacheDir, fetchImpl }: RunOptions = {}) {
  const fake = linkedinFake(fakeOptions);
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env,
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
    fetchImpl: fetchImpl ?? fake.impl,
    // A throwaway directory unless the test brings its own: nothing is ever written outside the temp dir.
    cacheDir: cacheDir ?? (await tempDir("unlinked-run-")),
    maxRetries: 0,
  });
  return {
    code,
    stdout,
    stderr,
    fake,
    json: () => JSON.parse(stdout) as any,
    /** The error object, asserting stderr is exactly one JSON line (plus optional warnings before it). */
    errorJson: () => JSON.parse(stderr.trim().split("\n").at(-1)!) as any,
  };
}
