import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runTestingPhase } from "../src/testingPhase.js";
import { TaskStateMachine } from "../src/stateMachine.js";
import type { TestAuthorAgentClient, TestAuthorAgentInput, TestAuthorResult } from "../src/agents/testAuthorAgent.js";
import type { TestResultAgentClient, TestResultAgentInput } from "../src/agents/testResultAgent.js";
import type { Plan, TestResult } from "../src/types.js";

const execFileAsync = promisify(execFile);

const samplePlan: Plan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

const authorResult: TestAuthorResult = {
  summary: "wrote a test",
  totalCostUsd: 0.01,
  usage: { inputTokens: 10, outputTokens: 10 },
};

class ScriptedTestAuthorClient implements TestAuthorAgentClient {
  constructor(private readonly onRun?: (input: TestAuthorAgentInput) => void) {}

  async runAuthoring(input: TestAuthorAgentInput): Promise<TestAuthorResult> {
    this.onRun?.(input);
    return authorResult;
  }
}

class ScriptedTestResultClient implements TestResultAgentClient {
  public receivedInput: TestResultAgentInput | undefined;

  constructor(private readonly result: TestResult) {}

  async runInterpretation(input: TestResultAgentInput): Promise<TestResult> {
    this.receivedInput = input;
    return this.result;
  }
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("runTestingPhase", () => {
  it("applies TESTS_PASSED and captures the diff (including files the Author step added)", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-testing-test-"));
    await execFileAsync("git", ["init", tempDir]);

    const testAuthorClient = new ScriptedTestAuthorClient((input) => {
      writeFileSync(path.join(input.repoDir, "x.test.ts"), "test('a1', () => {});\n", "utf-8");
    });
    const testResultClient = new ScriptedTestResultClient({
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: true }],
      testsRun: ["x.test.ts"],
    });
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });
    stateMachine.apply("s2", { type: "CODE_READY" });

    const result = await runTestingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "keep functions short",
      testCommand: 'node -e "process.exit(0)"',
      testCommandTimeoutMs: 10_000,
      stateMachine,
      testAuthorClient,
      testResultClient,
    });

    expect(stateMachine.getState().stage).toBe("review");
    expect(result.diff).toContain("x.test.ts");
    expect(result.testResult.results).toEqual([{ criterionId: "a1", passed: true }]);
    expect(testResultClient.receivedInput?.commandResult.exitCode).toBe(0);
  });

  it("applies TESTS_FAILED when the interpreted result has a failing criterion", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-testing-test-"));
    await execFileAsync("git", ["init", tempDir]);

    const testAuthorClient = new ScriptedTestAuthorClient();
    const testResultClient = new ScriptedTestResultClient({
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: false, reason: "assertion failed" }],
      testsRun: ["x.test.ts"],
    });
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });
    stateMachine.apply("s2", { type: "CODE_READY" });

    await runTestingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "keep functions short",
      testCommand: 'node -e "process.exit(1)"',
      testCommandTimeoutMs: 10_000,
      stateMachine,
      testAuthorClient,
      testResultClient,
    });

    expect(stateMachine.getState().stage).toBe("coding");
    expect(stateMachine.getState().fixReviewCycles).toBe(1);
  });

  it("escalates to human_gate when TESTS_FAILED exceeds the cycle cap", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-testing-test-"));
    await execFileAsync("git", ["init", tempDir]);

    const testAuthorClient = new ScriptedTestAuthorClient();
    const testResultClient = new ScriptedTestResultClient({
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: false, reason: "assertion failed" }],
      testsRun: [],
    });
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 0);
    stateMachine.apply("s1", { type: "PLAN_READY" });
    stateMachine.apply("s2", { type: "CODE_READY" });

    await runTestingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "keep functions short",
      testCommand: 'node -e "process.exit(1)"',
      testCommandTimeoutMs: 10_000,
      stateMachine,
      testAuthorClient,
      testResultClient,
    });

    expect(stateMachine.getState().stage).toBe("human_gate");
    expect(stateMachine.getState().escalated).toBe(true);
  });

  it("applies its event correctly across two retry legs without a stepId collision", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-testing-test-"));
    await execFileAsync("git", ["init", tempDir]);

    const testAuthorClient = new ScriptedTestAuthorClient();
    const failingResult: TestResult = {
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: false, reason: "assertion failed" }],
      testsRun: [],
    };
    const passingResult: TestResult = {
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: true }],
      testsRun: [],
    };
    let call = 0;
    const testResultClient: TestResultAgentClient = {
      async runInterpretation(): Promise<TestResult> {
        call += 1;
        return call === 1 ? failingResult : passingResult;
      },
    };
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });
    stateMachine.apply("s2", { type: "CODE_READY" });

    await runTestingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "r",
      testCommand: 'node -e "process.exit(1)"',
      testCommandTimeoutMs: 10_000,
      stateMachine,
      testAuthorClient,
      testResultClient,
    });
    expect(stateMachine.getState().stage).toBe("coding");

    stateMachine.apply("s3", { type: "CODE_READY" });
    expect(stateMachine.getState().stage).toBe("testing");

    await runTestingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "r",
      testCommand: 'node -e "process.exit(0)"',
      testCommandTimeoutMs: 10_000,
      stateMachine,
      testAuthorClient,
      testResultClient,
    });

    // If the second call's stepId collided with the first, this apply
    // would be a silent no-op and the stage would still read "testing".
    expect(stateMachine.getState().stage).toBe("review");
    expect(call).toBe(2);
  });
});
