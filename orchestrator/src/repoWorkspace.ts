import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { taskWorkspacePath } from "./workspace.js";
import type { ProjectConfig } from "./projectConfig.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    throw new Error(`git ${args.join(" ")} failed: ${stderr || (error as Error).message}`);
  }
}

export function repoDirPath(taskId: string, root?: string): string {
  return path.join(taskWorkspacePath(taskId, root), "repo");
}

/**
 * Populates workspace/<task-id>/repo/ — clones repo.source if the project
 * has one, otherwise git-inits an empty directory for a new project.
 * Idempotent: if the repo is already there (from a prior run of the same
 * task), it's reused as-is rather than re-cloned over the Coder's work.
 */
export async function prepareRepoWorkspace(
  taskId: string,
  projectConfig: ProjectConfig,
  root?: string,
): Promise<string> {
  const repoDir = repoDirPath(taskId, root);
  if (existsSync(path.join(repoDir, ".git"))) {
    return repoDir;
  }

  if (projectConfig.repo.source) {
    const args = ["clone"];
    if (projectConfig.repo.defaultBranch) {
      args.push("-b", projectConfig.repo.defaultBranch);
    }
    args.push(projectConfig.repo.source, repoDir);
    await runGit(args);
  } else {
    await runGit(["init", repoDir]);
  }

  return repoDir;
}

/**
 * Stages everything and returns the diff against whatever HEAD was before
 * Coder ran (or against the empty tree for a brand-new repo) — the "diff"
 * CLAUDE.md's Coder stage is defined to output. Doesn't commit: the
 * working tree is left exactly as Coder produced it for Tester to use.
 */
export async function captureDiff(repoDir: string): Promise<string> {
  await runGit(["add", "-A"], repoDir);
  return runGit(["diff", "--cached", "--no-color"], repoDir);
}
