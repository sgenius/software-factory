import { TaskStateMachine } from "./stateMachine.js";
import { runPlanningPhase, type PlanningTranscriptEntry } from "./planningPhase.js";
import type { PlannerAgentClient } from "./agents/plannerAgent.js";
import type { HumanInteractionChannel } from "./humanInteraction.js";
import type { ProjectConfig } from "./projectConfig.js";
import { DEFAULT_WORKSPACE_ROOT, ensureTaskWorkspace, writeTaskArtifact } from "./workspace.js";
import type { TaskState } from "./types.js";

export interface RunTaskOptions {
  taskId: string;
  requirement: string;
  projectConfig: ProjectConfig;
  /** Real ClaudePlannerAgentClient from cli.ts; a fake/scripted client in tests. */
  plannerClient: PlannerAgentClient;
  /** Real CliHumanInteractionChannel from cli.ts; a fake/scripted channel in tests. */
  interactionChannel: HumanInteractionChannel;
  workspaceRoot?: string;
}

/**
 * Runs one task through the "planning" stage end to end: scaffolds the
 * task workspace, runs the interactive planning phase, and persists
 * plan.json / planning-transcript.json / task-state.json. On success the
 * task legitimately lands in the "coding" stage — this function does not
 * drive Coder/Tester/Reviewer, which aren't wired up yet.
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
    return stateMachine.getState();
  } catch (error) {
    // runPlanningPhase's own guardrail (exhausted question rounds) already
    // applies STAGE_FAILED before throwing. Anything else (a planner call
    // erroring, malformed output surviving retries) wouldn't have — mark
    // the task failed here too, so task-state.json never says
    // "in_progress" for a task nothing will ever advance again.
    if (stateMachine.getState().status === "in_progress") {
      stateMachine.apply(`${opts.taskId}:planning:error`, {
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
