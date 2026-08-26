import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runProjectTestCommand } from "../src/testExecution.js";

let tempDir: string | undefined;

// On Windows, exec's timeout kills only the cmd.exe shell wrapper, not the
// grandchild node process it spawned (a known Node/Windows limitation, not
// a bug in runProjectTestCommand) — the orphan keeps a lock on its cwd
// until it exits on its own. fs.rmSync's maxRetries/retryDelay options
// don't cover this path (verified empirically: fails in ~1ms regardless),
// so retry with real awaited delays instead, giving the orphan time to
// actually exit.
async function removeTempDirWithRetry(dir: string): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await sleep(150);
    }
  }
}

afterEach(async () => {
  if (tempDir) {
    await removeTempDirWithRetry(tempDir);
    tempDir = undefined;
  }
});

describe("runProjectTestCommand", () => {
  it("returns exitCode 0 and captured stdout on success", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-exec-test-"));

    const result = await runProjectTestCommand(
      tempDir,
      'node -e "console.log(\'hello from test\'); process.exit(0)"',
      10_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from test");
  });

  it("returns a non-zero exitCode normally (not thrown) when the command fails", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-exec-test-"));

    const result = await runProjectTestCommand(
      tempDir,
      'node -e "console.error(\'boom\'); process.exit(1)"',
      10_000,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("throws when the command times out", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-exec-test-"));

    // Short internal delay (rather than a true hang): keeps the orphaned
    // grandchild process's lifetime (see removeTempDirWithRetry above)
    // well under the cleanup retry budget, so cleanup doesn't race it.
    await expect(
      runProjectTestCommand(tempDir, 'node -e "setTimeout(() => {}, 800)"', 200),
    ).rejects.toThrow(/timed out/);
  });

  it("runs the command inside repoDir", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-exec-test-"));

    const result = await runProjectTestCommand(tempDir, "node -e \"console.log(process.cwd())\"", 10_000);

    expect(result.stdout.trim().toLowerCase()).toBe(tempDir.toLowerCase());
  });
});
