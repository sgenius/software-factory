import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface TestCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

/**
 * Runs the project's configured test command deterministically — never
 * through an LLM-controlled shell. Uses Node's own exec, which spawns the
 * OS's default shell (/bin/sh on POSIX, cmd.exe on Windows), not Bash
 * specifically, so this works regardless of what shell the target project
 * itself assumes.
 *
 * A non-zero exit is a normal, valid result (the tests failed) and is
 * returned, not thrown. A timeout is an orchestrator-level problem, not a
 * test outcome, so it throws instead.
 */
export async function runProjectTestCommand(
  repoDir: string,
  testCommand: string,
  timeoutMs: number,
): Promise<TestCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(testCommand, {
      cwd: repoDir,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const execError = error as ExecError;
    if (execError.killed) {
      throw new Error(`Test command "${testCommand}" timed out after ${timeoutMs}ms`);
    }
    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
    };
  }
}
