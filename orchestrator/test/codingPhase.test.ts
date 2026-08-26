import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodingPhase } from "../src/codingPhase.js";
import { TaskStateMachine } from "../src/stateMachine.js";
import type { CoderAgentClient, CoderAgentInput, CoderAgentResult } from "../src/agents/coderAgent.js";
import type { Plan, TestResult } from "../src/types.js";

const samplePlan: Plan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

class ScriptedCoderClient implements CoderAgentClient {
  public receivedInputs: CoderAgentInput[] = [];

  constructor(private readonly result: CoderAgentResult) {}

  async runCoding(input: CoderAgentInput): Promise<CoderAgentResult> {
    this.receivedInputs.push(input);
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

describe("runCodingPhase", () => {
  it("applies CODE_READY and returns the Coder's summary", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-coding-test-"));

    const coderClient = new ScriptedCoderClient({
      summary: "done",
      totalCostUsd: 0.01,
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });

    const result = await runCodingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "keep functions short",
      stateMachine,
      coderClient,
    });

    expect(stateMachine.getState().stage).toBe("testing");
    expect(result.summary).toBe("done");
    expect(coderClient.receivedInputs[0]).toMatchObject({ taskId: "task-1", plan: samplePlan, repoDir: tempDir });
  });

  it("passes feedback through as priorFeedback", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-coding-test-"));

    const coderClient = new ScriptedCoderClient({
      summary: "fixed",
      totalCostUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });

    const testResult: TestResult = {
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: false, reason: "assertion failed" }],
      testsRun: [],
    };

    await runCodingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "keep functions short",
      stateMachine,
      coderClient,
      feedback: { kind: "test_failure", testResult },
    });

    expect(coderClient.receivedInputs[0].priorFeedback).toEqual({ kind: "test_failure", testResult });
  });

  it("applies CODE_READY correctly across two retry legs without a stepId collision", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-coding-test-"));

    const coderClient = new ScriptedCoderClient({
      summary: "done",
      totalCostUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });

    await runCodingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "r",
      stateMachine,
      coderClient,
    });
    expect(stateMachine.getState().stage).toBe("testing");

    // Simulate the leg between two coding passes: testing fails, looping
    // back to "coding" and advancing fixReviewCycles the way
    // TaskStateMachine's own loopToCoding really does.
    stateMachine.apply("s2", { type: "TESTS_FAILED" });
    expect(stateMachine.getState().stage).toBe("coding");
    expect(stateMachine.getState().fixReviewCycles).toBe(1);

    const secondResult = await runCodingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "r",
      stateMachine,
      coderClient,
    });

    // If the stepId collided with the first call's, this apply would be a
    // silent no-op and the stage would still read "coding".
    expect(stateMachine.getState().stage).toBe("testing");
    expect(secondResult.summary).toBe("done");
    expect(coderClient.receivedInputs).toHaveLength(2);
  });
});
