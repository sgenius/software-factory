import { describe, expect, it } from "vitest";
import { runReviewPhase } from "../src/reviewPhase.js";
import { TaskStateMachine } from "../src/stateMachine.js";
import type { ReviewerAgentClient, ReviewerAgentInput } from "../src/agents/reviewerAgent.js";
import type { Plan, ReviewResult } from "../src/types.js";

const samplePlan: Plan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

class ScriptedReviewerClient implements ReviewerAgentClient {
  public receivedInput: ReviewerAgentInput | undefined;

  constructor(private readonly result: ReviewResult) {}

  async runReview(input: ReviewerAgentInput): Promise<ReviewResult> {
    this.receivedInput = input;
    return this.result;
  }
}

function makeStateMachineAtReview(maxFixReviewCycles = 3): TaskStateMachine {
  const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, maxFixReviewCycles);
  stateMachine.apply("s1", { type: "PLAN_READY" });
  stateMachine.apply("s2", { type: "CODE_READY" });
  stateMachine.apply("s3", { type: "TESTS_PASSED" });
  return stateMachine;
}

describe("runReviewPhase", () => {
  it("applies REVIEW_CLEAN when there are no findings", async () => {
    const reviewerClient = new ScriptedReviewerClient({ taskId: "task-1", findings: [], confidence: 0.9 });
    const stateMachine = makeStateMachineAtReview();

    const result = await runReviewPhase({
      taskId: "task-1",
      plan: samplePlan,
      diff: "diff --git a/x.ts b/x.ts",
      rubricText: "keep functions short",
      stateMachine,
      reviewerClient,
    });

    expect(stateMachine.getState().stage).toBe("human_gate");
    expect(stateMachine.getState().escalated).toBe(false);
    expect(result.findings).toEqual([]);
    expect(reviewerClient.receivedInput?.diff).toContain("diff --git");
  });

  it("applies REVIEW_CLEAN when findings exist but none are blocking", async () => {
    const reviewerClient = new ScriptedReviewerClient({
      taskId: "task-1",
      findings: [{ taskId: "task-1", file: "x.ts", line: 3, severity: "nit", summary: "rename variable" }],
      confidence: 0.8,
    });
    const stateMachine = makeStateMachineAtReview();

    await runReviewPhase({
      taskId: "task-1",
      plan: samplePlan,
      diff: "diff --git a/x.ts b/x.ts",
      rubricText: "keep functions short",
      stateMachine,
      reviewerClient,
    });

    expect(stateMachine.getState().stage).toBe("human_gate");
  });

  it("applies REVIEW_NEEDS_FIXES when a finding is blocking", async () => {
    const reviewerClient = new ScriptedReviewerClient({
      taskId: "task-1",
      findings: [{ taskId: "task-1", file: "x.ts", line: 3, severity: "blocking", summary: "scope creep" }],
      confidence: 0.95,
    });
    const stateMachine = makeStateMachineAtReview();

    await runReviewPhase({
      taskId: "task-1",
      plan: samplePlan,
      diff: "diff --git a/x.ts b/x.ts",
      rubricText: "keep functions short",
      stateMachine,
      reviewerClient,
    });

    expect(stateMachine.getState().stage).toBe("coding");
    expect(stateMachine.getState().fixReviewCycles).toBe(1);
  });
});
