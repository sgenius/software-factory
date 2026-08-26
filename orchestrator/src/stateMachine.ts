import type { Budget, HistoryEntry, Spend, Stage, TaskState, TaskStatus } from "./types.js";

/**
 * Events the orchestrator feeds into the state machine. Each event maps to
 * one stage agent finishing its work (or the human gate resolving).
 */
export type TaskEvent =
  | { type: "PLAN_READY" }
  | { type: "CODE_READY" }
  | { type: "TESTS_PASSED" }
  | { type: "TESTS_FAILED" }
  | { type: "REVIEW_CLEAN" }
  | { type: "REVIEW_NEEDS_FIXES" }
  | { type: "HUMAN_APPROVED" }
  | { type: "HUMAN_REJECTED"; reason?: string }
  | { type: "HUMAN_REQUESTED_CHANGES" }
  | { type: "STAGE_FAILED"; reason: string };

/**
 * Explicit state machine for one task: planning -> coding -> testing ->
 * review -> human_gate -> done/failed (CLAUDE.md "Orchestrator").
 *
 * Guardrails enforced here, not left to agent judgment:
 * - fix/review cycles are capped; hitting the cap escalates to the human
 *   gate instead of looping forever, and a further rejection there fails
 *   the task outright (the cap is exhausted, not just "try once more").
 * - spend is checked on every recordSpend call; exceeding budget force-
 *   fails the task regardless of stage.
 * - every mutating call takes a stepId; replaying the same stepId is a
 *   no-op, so a retried orchestrator step can't double-apply.
 */
export class TaskStateMachine {
  private stage: Stage = "planning";
  private status: TaskStatus = "in_progress";
  private fixReviewCycles = 0;
  private escalated = false;
  private spend: Spend = { tokens: 0, costUsd: 0 };
  private failureReason: string | undefined;
  private readonly history: HistoryEntry[] = [];
  private readonly processedSteps = new Set<string>();

  constructor(
    private readonly taskId: string,
    private readonly budget: Budget,
    private readonly maxFixReviewCycles: number,
  ) {}

  getState(): TaskState {
    return {
      taskId: this.taskId,
      stage: this.stage,
      status: this.status,
      fixReviewCycles: this.fixReviewCycles,
      maxFixReviewCycles: this.maxFixReviewCycles,
      escalated: this.escalated,
      spend: { ...this.spend },
      budget: { ...this.budget },
      ...(this.failureReason !== undefined ? { failureReason: this.failureReason } : {}),
      history: [...this.history],
    };
  }

  /** Idempotent: replaying an already-seen stepId is a no-op. */
  recordSpend(stepId: string, tokens: number, costUsd: number): TaskState {
    if (this.processedSteps.has(stepId) || this.status !== "in_progress") {
      return this.getState();
    }
    this.processedSteps.add(stepId);

    this.spend.tokens += tokens;
    this.spend.costUsd += costUsd;

    if (this.spend.tokens > this.budget.maxTokens || this.spend.costUsd > this.budget.maxCostUsd) {
      this.forceFail(stepId, "budget_exceeded");
    } else {
      this.recordHistory(stepId, "SPEND_RECORDED");
    }
    return this.getState();
  }

  /** Idempotent: replaying an already-seen stepId returns current state unchanged. */
  apply(stepId: string, event: TaskEvent): TaskState {
    if (this.processedSteps.has(stepId)) {
      return this.getState();
    }
    this.processedSteps.add(stepId);

    if (this.status !== "in_progress") {
      this.recordHistory(stepId, `IGNORED_${event.type}_TASK_TERMINAL`);
      return this.getState();
    }

    this.transition(stepId, event);
    return this.getState();
  }

  private transition(stepId: string, event: TaskEvent): void {
    switch (this.stage) {
      case "planning":
        if (event.type === "PLAN_READY") this.moveTo(stepId, "coding", event.type);
        else if (event.type === "STAGE_FAILED") this.forceFail(stepId, event.reason);
        else this.invalidEvent(event);
        return;

      case "coding":
        if (event.type === "CODE_READY") this.moveTo(stepId, "testing", event.type);
        else if (event.type === "STAGE_FAILED") this.forceFail(stepId, event.reason);
        else this.invalidEvent(event);
        return;

      case "testing":
        if (event.type === "TESTS_PASSED") this.moveTo(stepId, "review", event.type);
        else if (event.type === "TESTS_FAILED") this.loopToCoding(stepId, event.type);
        else if (event.type === "STAGE_FAILED") this.forceFail(stepId, event.reason);
        else this.invalidEvent(event);
        return;

      case "review":
        if (event.type === "REVIEW_CLEAN") this.moveTo(stepId, "human_gate", event.type);
        else if (event.type === "REVIEW_NEEDS_FIXES") this.loopToCoding(stepId, event.type);
        else if (event.type === "STAGE_FAILED") this.forceFail(stepId, event.reason);
        else this.invalidEvent(event);
        return;

      case "human_gate":
        if (event.type === "HUMAN_APPROVED") this.moveTo(stepId, "done", event.type);
        else if (event.type === "HUMAN_REJECTED") this.forceFail(stepId, event.reason ?? "human_rejected");
        else if (event.type === "HUMAN_REQUESTED_CHANGES") this.loopToCoding(stepId, event.type);
        else this.invalidEvent(event);
        return;

      default:
        this.invalidEvent(event);
    }
  }

  /** Shared by TESTS_FAILED / REVIEW_NEEDS_FIXES / HUMAN_REQUESTED_CHANGES. */
  private loopToCoding(stepId: string, eventName: string): void {
    if (this.fixReviewCycles >= this.maxFixReviewCycles) {
      if (this.stage === "human_gate") {
        // Already escalated once, and the human is still requesting changes
        // beyond the cap — the cycle budget is exhausted, not just "retry".
        this.forceFail(stepId, "fix_review_cycles_exhausted");
        return;
      }
      this.escalated = true;
      this.moveTo(stepId, "human_gate", `${eventName}_ESCALATED`);
      return;
    }
    this.fixReviewCycles += 1;
    this.moveTo(stepId, "coding", eventName);
  }

  private moveTo(stepId: string, nextStage: Stage, eventName: string): void {
    this.stage = nextStage;
    if (nextStage === "done") this.status = "done";
    this.recordHistory(stepId, eventName);
  }

  private forceFail(stepId: string, reason: string): void {
    this.stage = "failed";
    this.status = "failed";
    this.failureReason = reason;
    this.recordHistory(stepId, `FAILED:${reason}`);
  }

  private invalidEvent(event: TaskEvent): never {
    throw new Error(`Invalid event "${event.type}" for stage "${this.stage}" (task ${this.taskId})`);
  }

  private recordHistory(stepId: string, eventName: string): void {
    this.history.push({
      stepId,
      stage: this.stage,
      event: eventName,
      timestamp: new Date().toISOString(),
    });
  }
}
