import type { TaskStateMachine } from "./stateMachine.js";
import type { CoderAgentClient } from "./agents/coderAgent.js";
import type { Plan } from "./types.js";

export interface CodingPhaseOptions {
  taskId: string;
  plan: Plan;
  repoDir: string;
  rubricText: string;
  stateMachine: TaskStateMachine;
  coderClient: CoderAgentClient;
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
 */
export async function runCodingPhase(opts: CodingPhaseOptions): Promise<CodingPhaseResult> {
  const result = await opts.coderClient.runCoding({
    taskId: opts.taskId,
    plan: opts.plan,
    repoDir: opts.repoDir,
    rubricText: opts.rubricText,
  });

  opts.stateMachine.apply(`${opts.taskId}:coding:code-ready`, { type: "CODE_READY" });

  return { summary: result.summary };
}
