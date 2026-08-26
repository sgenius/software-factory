import type { TaskStateMachine } from "./stateMachine.js";
import type { ReviewerAgentClient } from "./agents/reviewerAgent.js";
import type { Plan, ReviewResult } from "./types.js";

export interface ReviewPhaseOptions {
  taskId: string;
  plan: Plan;
  diff: string;
  rubricText: string;
  stateMachine: TaskStateMachine;
  reviewerClient: ReviewerAgentClient;
}

/**
 * Runs the Reviewer once and applies REVIEW_CLEAN/REVIEW_NEEDS_FIXES,
 * derived from whether any finding is severity "blocking" — no redundant
 * verdict field for the Reviewer to also get right. Errors are left to
 * propagate — taskRunner.ts's generic catch-all handles them.
 */
export async function runReviewPhase(opts: ReviewPhaseOptions): Promise<ReviewResult> {
  const reviewResult = await opts.reviewerClient.runReview({
    taskId: opts.taskId,
    plan: opts.plan,
    diff: opts.diff,
    rubricText: opts.rubricText,
  });

  // Cycle-suffixed stepId: see the comment on the same pattern in
  // codingPhase.ts — this phase can now run more than once per task.
  const cycle = opts.stateMachine.getState().fixReviewCycles;
  const hasBlocking = reviewResult.findings.some((finding) => finding.severity === "blocking");
  const event = hasBlocking ? { type: "REVIEW_NEEDS_FIXES" as const } : { type: "REVIEW_CLEAN" as const };
  opts.stateMachine.apply(`${opts.taskId}:review:result:cycle-${cycle}`, event);

  return reviewResult;
}
