import type { TaskStateMachine } from "./stateMachine.js";
import { captureDiff } from "./repoWorkspace.js";
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
  diff: string;
  summary: string;
}

/**
 * Runs the Coder once against the plan, captures its changes as a diff,
 * and applies CODE_READY. Errors from coderClient.runCoding are left to
 * propagate — taskRunner.ts's generic catch-all marks the task failed the
 * same way it already does for planning errors.
 */
export async function runCodingPhase(opts: CodingPhaseOptions): Promise<CodingPhaseResult> {
  const result = await opts.coderClient.runCoding({
    taskId: opts.taskId,
    plan: opts.plan,
    repoDir: opts.repoDir,
    rubricText: opts.rubricText,
  });

  const diff = await captureDiff(opts.repoDir);
  if (diff.trim().length === 0) {
    console.warn(`Coder produced no changes for task ${opts.taskId}.`);
  }

  opts.stateMachine.apply(`${opts.taskId}:coding:code-ready`, { type: "CODE_READY" });

  return { diff, summary: result.summary };
}
