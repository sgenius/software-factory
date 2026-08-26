import type { TaskStateMachine } from "./stateMachine.js";
import type { CoderAgentClient } from "./agents/coderAgent.js";
import type { CoderFeedback, Plan } from "./types.js";

export interface CodingPhaseOptions {
  taskId: string;
  plan: Plan;
  repoDir: string;
  rubricText: string;
  stateMachine: TaskStateMachine;
  coderClient: CoderAgentClient;
  /** Set on a fix cycle — passed straight through to CoderAgentInput.priorFeedback. */
  feedback?: CoderFeedback;
}

export interface CodingPhaseResult {
  summary: string;
}

/**
 * Runs the Coder once against the plan and applies CODE_READY. The diff
 * isn't captured here — Tester's Author turn (testingPhase.ts) also edits
 * repoDir, so the diff isn't final until that's done too; captureDiff runs
 * there instead. Errors from coderClient.runCoding are left to propagate —
 * taskRunner.ts's generic catch-all marks the task failed the same way it
 * already does for planning errors.
 *
 * The stepId includes the state machine's own fixReviewCycles as a cycle
 * marker: this phase can now run more than once per task (the fix-retry
 * loop re-enters "coding"), and a hardcoded stepId would make the second
 * CODE_READY a silent no-op (TaskStateMachine.apply treats a repeated
 * stepId as already-applied). fixReviewCycles is stable for the whole
 * coding+testing+review leg — only loopToCoding increments it, between
 * legs — so it's a correct, already-available uniqueness key.
 */
export async function runCodingPhase(opts: CodingPhaseOptions): Promise<CodingPhaseResult> {
  const cycle = opts.stateMachine.getState().fixReviewCycles;

  const result = await opts.coderClient.runCoding({
    taskId: opts.taskId,
    plan: opts.plan,
    repoDir: opts.repoDir,
    rubricText: opts.rubricText,
    priorFeedback: opts.feedback,
  });

  opts.stateMachine.apply(`${opts.taskId}:coding:code-ready:cycle-${cycle}`, { type: "CODE_READY" });

  return { summary: result.summary };
}
