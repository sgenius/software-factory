import { readFileSync } from "node:fs";
import path from "node:path";
import { TaskStateMachine } from "./stateMachine.js";
import { runPlanningPhase, type PlanningTranscriptEntry } from "./planningPhase.js";
import { runCodingPhase } from "./codingPhase.js";
import { prepareRepoWorkspace } from "./repoWorkspace.js";
import { REPO_ROOT } from "./repoRoot.js";
import type { PlannerAgentClient } from "./agents/plannerAgent.js";
import type { CoderAgentClient } from "./agents/coderAgent.js";
import type { HumanInteractionChannel } from "./humanInteraction.js";
import type { ProjectConfig } from "./projectConfig.js";
import { DEFAULT_WORKSPACE_ROOT, ensureTaskWorkspace, writeTaskArtifact, writeTaskTextFile } from "./workspace.js";
import type { TaskState } from "./types.js";

export interface RunTaskOptions {
  taskId: string;
  requirement: string;
  projectConfig: ProjectConfig;
  /** Real ClaudePlannerAgentClient from cli.ts; a fake/scripted client in tests. */
  plannerClient: PlannerAgentClient;
  /** Real ClaudeCoderAgentClient from cli.ts; a fake/scripted client in tests. */
  coderClient: CoderAgentClient;
  /** Real CliHumanInteractionChannel from cli.ts; a fake/scripted channel in tests. */
  interactionChannel: HumanInteractionChannel;
  workspaceRoot?: string;
}

/**
 * Runs one task through "planning" and then "coding": scaffolds the task
 * workspace, runs the interactive planning phase, populates
 * workspace/<task-id>/repo/, runs the Coder, and persists plan.json /
 * planning-transcript.json / diff.patch / task-state.json throughout. On
 * success the task lands in the "testing" stage — Tester/Reviewer aren't
 * wired up yet.
 */
export async function runTask(opts: RunTaskOptions): Promise<TaskState> {
  const root = opts.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  await ensureTaskWorkspace(opts.taskId, root);

  const stateMachine = new TaskStateMachine(
    opts.taskId,
    {
      maxTokens: opts.projectConfig.budget.maxTokensPerTask,
      maxCostUsd: opts.projectConfig.budget.maxCostUsdPerTask,
    },
    opts.projectConfig.budget.maxFixReviewCycles,
  );
  await persistTaskState(opts.taskId, stateMachine, root);

  const transcript: PlanningTranscriptEntry[] = [];
  const persistTranscript = async (entry: PlanningTranscriptEntry): Promise<void> => {
    transcript.push(entry);
    await writeTaskArtifact(opts.taskId, "planning-transcript.json", transcript, root);
  };

  try {
    const plan = await runPlanningPhase({
      taskId: opts.taskId,
      requirement: opts.requirement,
      stateMachine,
      plannerClient: opts.plannerClient,
      interactionChannel: opts.interactionChannel,
      maxQuestionRounds: opts.projectConfig.budget.maxPlanningQuestionRounds,
      persistTranscript,
    });

    stateMachine.apply(`${opts.taskId}:planning:plan-ready`, { type: "PLAN_READY" });
    await writeTaskArtifact(opts.taskId, "plan.json", plan, root);
    await persistTaskState(opts.taskId, stateMachine, root);

    const repoDir = await prepareRepoWorkspace(opts.taskId, opts.projectConfig, root);
    const rubricText = readFileSync(path.join(REPO_ROOT, opts.projectConfig.rubric.path), "utf-8");

    const { diff } = await runCodingPhase({
      taskId: opts.taskId,
      plan,
      repoDir,
      rubricText,
      stateMachine,
      coderClient: opts.coderClient,
    });

    await writeTaskTextFile(opts.taskId, "diff.patch", diff, root);
    await persistTaskState(opts.taskId, stateMachine, root);
    return stateMachine.getState();
  } catch (error) {
    // Guardrails inside runPlanningPhase/runCodingPhase already apply
    // STAGE_FAILED for the failure modes they know about. Anything else
    // (a planner/coder call erroring, a git operation failing) wouldn't
    // have — mark the task failed here too, so task-state.json never says
    // "in_progress" for a task nothing will ever advance again.
    if (stateMachine.getState().status === "in_progress") {
      stateMachine.apply(`${opts.taskId}:${stateMachine.getState().stage}:error`, {
        type: "STAGE_FAILED",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    await persistTaskState(opts.taskId, stateMachine, root);
    throw error;
  }
}

async function persistTaskState(taskId: string, stateMachine: TaskStateMachine, root: string): Promise<void> {
  await writeTaskArtifact(taskId, "task-state.json", stateMachine.getState(), root);
}
