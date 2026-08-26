import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureDiff, prepareRepoWorkspace, repoDirPath } from "../src/repoWorkspace.js";
import type { ProjectConfig } from "../src/projectConfig.js";

const execFileAsync = promisify(execFile);

const baseProjectConfig: ProjectConfig = {
  name: "test-project",
  repo: {},
  rubric: { path: "rubrics/legibility-default.md" },
  budget: {
    maxTokensPerTask: 1000,
    maxCostUsdPerTask: 1,
    maxFixReviewCycles: 1,
    maxPlanningQuestionRounds: 1,
    maxCoderTurns: 1,
  },
};

async function initLocalRemote(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hello\n", "utf-8");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("prepareRepoWorkspace", () => {
  it("git-inits an empty repo when the project has no repo.source", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-repo-test-"));
    const repoDir = await prepareRepoWorkspace("task-1", baseProjectConfig, tempDir);

    expect(repoDir).toBe(repoDirPath("task-1", tempDir));
    expect(existsSync(path.join(repoDir, ".git"))).toBe(true);
  });

  it("clones repo.source (a local path — no network) when set", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-repo-test-"));
    const remoteDir = path.join(tempDir, "remote");
    await execFileAsync("git", ["init", remoteDir]);
    await initLocalRemote(remoteDir);

    const projectConfig: ProjectConfig = { ...baseProjectConfig, repo: { source: remoteDir } };
    const repoDir = await prepareRepoWorkspace("task-2", projectConfig, tempDir);

    expect(existsSync(path.join(repoDir, ".git"))).toBe(true);
    // Normalize line endings: Windows git's core.autocrlf may rewrite LF -> CRLF on checkout.
    expect(readFileSync(path.join(repoDir, "README.md"), "utf-8").replace(/\r\n/g, "\n")).toBe("hello\n");
  });

  it("is idempotent: a second call reuses the existing repo instead of re-cloning", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-repo-test-"));
    const repoDir = await prepareRepoWorkspace("task-3", baseProjectConfig, tempDir);
    writeFileSync(path.join(repoDir, "marker.txt"), "keep me", "utf-8");

    const repoDirAgain = await prepareRepoWorkspace("task-3", baseProjectConfig, tempDir);

    expect(repoDirAgain).toBe(repoDir);
    expect(readFileSync(path.join(repoDir, "marker.txt"), "utf-8")).toBe("keep me");
  });
});

describe("captureDiff", () => {
  it("returns an empty string for a clean repo", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-repo-test-"));
    const repoDir = await prepareRepoWorkspace("task-4", baseProjectConfig, tempDir);

    expect(await captureDiff(repoDir)).toBe("");
  });

  it("returns the patch text for staged/unstaged changes, including new files", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-repo-test-"));
    const repoDir = await prepareRepoWorkspace("task-5", baseProjectConfig, tempDir);
    writeFileSync(path.join(repoDir, "hello.txt"), "hello world\n", "utf-8");

    const diff = await captureDiff(repoDir);

    expect(diff).toContain("hello.txt");
    expect(diff).toContain("hello world");
  });
});
