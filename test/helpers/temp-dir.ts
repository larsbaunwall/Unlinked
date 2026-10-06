import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** Creates a temp directory that is removed when the current test file finishes. */
export async function tempDir(prefix = "unlinked-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
