import { describe, expect, it } from "vitest";
import { TaskStateMachine } from "../src/stateMachine.js";

function makeMachine(overrides?: { maxFixReviewCycles?: number; maxTokens?: number; maxCostUsd?: number }) {
  return new TaskStateMachine(
    "task-1",
    { maxTokens: overrides?.maxTokens ?? 1_000_000, maxCostUsd: overrides?.maxCostUsd ?? 100 },
    overrides?.maxFixReviewCycles ?? 3,
  );
}

describe("TaskStateMachine happy path", () => {
  it("walks planning -> coding -> testing -> review -> human_gate -> done", () => {
    const m = makeMachine();
    m.apply("s1", { type: "PLAN_READY" });
    m.apply("s2", { type: "CODE_READY" });
    m.apply("s3", { type: "TESTS_PASSED" });
    m.apply("s4", { type: "REVIEW_CLEAN" });
    const state = m.apply("s5", { type: "HUMAN_APPROVED" });

    expect(state.stage).toBe("done");
    expect(state.status).toBe("done");
    expect(state.fixReviewCycles).toBe(0);
    expect(state.escalated).toBe(false);
    expect(state.history.map((h) => h.event)).toEqual([
      "PLAN_READY",
      "CODE_READY",
      "TESTS_PASSED",
      "REVIEW_CLEAN",
      "HUMAN_APPROVED",
    ]);
  });
});

describe("fix/review cycles", () => {
  it("loops testing -> coding on TESTS_FAILED and counts the cycle", () => {
    const m = makeMachine({ maxFixReviewCycles: 3 });
    m.apply("s1", { type: "PLAN_READY" });
    m.apply("s2", { type: "CODE_READY" });
    const state = m.apply("s3", { type: "TESTS_FAILED" });

    expect(state.stage).toBe("coding");
    expect(state.fixReviewCycles).toBe(1);
    expect(state.escalated).toBe(false);
  });

  it("escalates to human_gate once the cycle cap is reached instead of looping again", () => {
    const m = makeMachine({ maxFixReviewCycles: 1 });
    m.apply("s1", { type: "PLAN_READY" });
    m.apply("s2", { type: "CODE_READY" });
    m.apply("s3", { type: "TESTS_FAILED" }); // cycle 1/1, back to coding
    m.apply("s4", { type: "CODE_READY" });
    const state = m.apply("s5", { type: "TESTS_FAILED" }); // cap reached -> escalate

    expect(state.stage).toBe("human_gate");
    expect(state.status).toBe("in_progress");
    expect(state.escalated).toBe(true);
    expect(state.fixReviewCycles).toBe(1);
  });

  it("fails the task if the human still requests changes after escalation", () => {
    const m = makeMachine({ maxFixReviewCycles: 0 });
    m.apply("s1", { type: "PLAN_READY" });
    m.apply("s2", { type: "CODE_READY" });
    m.apply("s3", { type: "TESTS_PASSED" });
    const escalated = m.apply("s4", { type: "REVIEW_NEEDS_FIXES" }); // cap 0 -> immediate escalation
    expect(escalated.stage).toBe("human_gate");

    const state = m.apply("s5", { type: "HUMAN_REQUESTED_CHANGES" });
    expect(state.stage).toBe("failed");
    expect(state.status).toBe("failed");
    expect(state.failureReason).toBe("fix_review_cycles_exhausted");
  });
});

describe("budget guardrail", () => {
  it("force-fails the task once spend exceeds the budget, regardless of stage", () => {
    const m = makeMachine({ maxTokens: 100, maxCostUsd: 1 });
    m.apply("s1", { type: "PLAN_READY" });
    const state = m.recordSpend("spend-1", 150, 0.5);

    expect(state.stage).toBe("failed");
    expect(state.status).toBe("failed");
    expect(state.failureReason).toBe("budget_exceeded");
  });

  it("ignores further events once failed", () => {
    const m = makeMachine({ maxTokens: 100, maxCostUsd: 1 });
    m.apply("s1", { type: "PLAN_READY" });
    m.recordSpend("spend-1", 150, 0.5);
    const state = m.apply("s2", { type: "CODE_READY" });

    expect(state.stage).toBe("failed");
    expect(state.history.at(-1)?.event).toBe("IGNORED_CODE_READY_TASK_TERMINAL");
  });
});

describe("idempotency", () => {
  it("replaying the same stepId is a no-op", () => {
    const m = makeMachine();
    const first = m.apply("s1", { type: "PLAN_READY" });
    const replay = m.apply("s1", { type: "PLAN_READY" });

    expect(replay).toEqual(first);
    expect(replay.history).toHaveLength(1);
  });

  it("replaying a spend stepId does not double-charge the budget", () => {
    const m = makeMachine({ maxTokens: 1000, maxCostUsd: 10 });
    m.recordSpend("spend-1", 400, 4);
    const state = m.recordSpend("spend-1", 400, 4);

    expect(state.spend.tokens).toBe(400);
    expect(state.spend.costUsd).toBe(4);
  });
});

describe("invalid transitions", () => {
  it("throws on an event that doesn't apply to the current stage", () => {
    const m = makeMachine();
    expect(() => m.apply("s1", { type: "TESTS_PASSED" })).toThrow(/Invalid event/);
  });
});
