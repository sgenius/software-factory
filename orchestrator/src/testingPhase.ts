import type { TaskStateMachine } from "./stateMachine.js";
import { captureDiff } from "./repoWorkspace.js";
import { runProjectTestCommand } from "./testExecution.js";
import type { TestAuthorAgentClient } from "./agents/testAuthorAgent.js";
import type { TestResultAgentClient } from "./agents/testResultAgent.js";
import type { Plan, TestResult } from "./types.js";

export interface TestingPhaseOptions {
  taskId: string;
  plan: Plan;
  repoDir: string;
  rubricText: string;
  testCommand: string;
  testCommandTimeoutMs: number;
  stateMachine: TaskStateMachine;
  testAuthorClient: TestAuthorAgentClient;
  testResultClient: TestResultAgentClient;
}

export interface TestingPhaseResult {
  testResult: TestResult;
  diff: string;
}

/**
 * Author (writes tests) -> capture the diff (now final — Coder and Tester
 * have both finished editing repoDir) -> run the project's test command
 * for real, deterministically -> Report (interprets the real output into
 * a structured verdict) -> apply TESTS_PASSED/TESTS_FAILED. Errors are
 * left to propagate — taskRunner.ts's generic catch-all handles them.
 */
export async function runTestingPhase(opts: TestingPhaseOptions): Promise<TestingPhaseResult> {
  await opts.testAuthorClient.runAuthoring({
    taskId: opts.taskId,
    plan: opts.plan,
    repoDir: opts.repoDir,
    rubricText: opts.rubricText,
    testCommand: opts.testCommand,
  });

  const diff = await captureDiff(opts.repoDir);

  const commandResult = await runProjectTestCommand(opts.repoDir, opts.testCommand, opts.testCommandTimeoutMs);

  const testResult = await opts.testResultClient.runInterpretation({
    taskId: opts.taskId,
    plan: opts.plan,
    testCommand: opts.testCommand,
    commandResult,
  });

  // Cycle-suffixed stepId: see the comment on the same pattern in
  // codingPhase.ts — this phase can now run more than once per task.
  const cycle = opts.stateMachine.getState().fixReviewCycles;
  const allPassed = testResult.results.every((result) => result.passed);
  const event = allPassed ? { type: "TESTS_PASSED" as const } : { type: "TESTS_FAILED" as const };
  opts.stateMachine.apply(`${opts.taskId}:testing:result:cycle-${cycle}`, event);

  return { testResult, diff };
}
