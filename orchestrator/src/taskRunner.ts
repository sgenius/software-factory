import { readFileSync } from "node:fs";
import path from "node:path";
import { TaskStateMachine } from "./stateMachine.js";
import { runPlanningPhase, type PlanningTranscriptEntry } from "./planningPhase.js";
import { runCodingPhase } from "./codingPhase.js";
import { runTestingPhase } from "./testingPhase.js";
import { runReviewPhase } from "./reviewPhase.js";
import { prepareRepoWorkspace } from "./repoWorkspace.js";
import { REPO_ROOT } from "./repoRoot.js";
import type { PlannerAgentClient } from "./agents/plannerAgent.js";
import type { CoderAgentClient } from "./agents/coderAgent.js";
import type { TestAuthorAgentClient } from "./agents/testAuthorAgent.js";
import type { TestResultAgentClient } from "./agents/testResultAgent.js";
import type { ReviewerAgentClient } from "./agents/reviewerAgent.js";
import type { HumanInteractionChannel } from "./humanInteraction.js";
import type { HumanGateChannel, HumanGateDecision } from "./humanGate.js";
import type { ProjectConfig } from "./projectConfig.js";
import { DEFAULT_WORKSPACE_ROOT, ensureTaskWorkspace, writeTaskArtifact, writeTaskTextFile } from "./workspace.js";
import type { CoderFeedback, ReviewResult, TaskState, TestResult } from "./types.js";

export interface RunTaskOptions {
  taskId: string;
  requirement: string;
  projectConfig: ProjectConfig;
  /** Real ClaudePlannerAgentClient from cli.ts; a fake/scripted client in tests. */
  plannerClient: PlannerAgentClient;
  /** Real ClaudeCoderAgentClient from cli.ts; a fake/scripted client in tests. */
  coderClient: CoderAgentClient;
  /** Real ClaudeTestAuthorAgentClient from cli.ts; a fake/scripted client in tests. */
  testAuthorClient: TestAuthorAgentClient;
  /** Real ClaudeTestResultAgentClient from cli.ts; a fake/scripted client in tests. */
  testResultClient: TestResultAgentClient;
  /** Real ClaudeReviewerAgentClient from cli.ts; a fake/scripted client in tests. */
  reviewerClient: ReviewerAgentClient;
  /** Real CliHumanInteractionChannel from cli.ts; a fake/scripted channel in tests. */
  interactionChannel: HumanInteractionChannel;
  /** Real CliHumanGateChannel from cli.ts; a fake/scripted channel in tests. */
  humanGateChannel: HumanGateChannel;
  workspaceRoot?: string;
}

interface HumanGateLogEntry {
  round: number;
  decision: HumanGateDecision;
  timestamp: string;
}

/**
 * Runs one task start to finish: planning, then a loop over
 * coding/testing/review/human_gate driven by the state machine's own
 * stage, until it reaches "done" or "failed". A failed test, a blocking
 * review finding, or a human requesting changes all feed back into
 * Coder's next pass the same way (CoderFeedback) and re-enter the same
 * loop — the fix-cycle cap and human_gate escalation are enforced by
 * TaskStateMachine itself, not here.
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

    let feedback: CoderFeedback | undefined;
    let diff = "";
    let testResult: TestResult | undefined;
    let reviewResult: ReviewResult | undefined;
    const humanGateLog: HumanGateLogEntry[] = [];

    while (true) {
      const stage = stateMachine.getState().stage;

      if (stage === "coding") {
        await runCodingPhase({
          taskId: opts.taskId,
          plan,
          repoDir,
          rubricText,
          stateMachine,
          coderClient: opts.coderClient,
          feedback,
        });
        feedback = undefined;
        // A fresh coding pass invalidates any review from a prior cycle —
        // if this leg's testing fails before ever reaching review again,
        // the human gate must not present stale findings from an earlier
        // diff.
        reviewResult = undefined;
        await persistTaskState(opts.taskId, stateMachine, root);
        continue;
      }

      if (stage === "testing") {
        const testingResult = await runTestingPhase({
          taskId: opts.taskId,
          plan,
          repoDir,
          rubricText,
          testCommand: opts.projectConfig.stack.testCommand,
          testCommandTimeoutMs: opts.projectConfig.budget.testCommandTimeoutMs,
          stateMachine,
          testAuthorClient: opts.testAuthorClient,
          testResultClient: opts.testResultClient,
        });
        testResult = testingResult.testResult;
        diff = testingResult.diff;
        await writeTaskTextFile(opts.taskId, "diff.patch", diff, root);
        await writeTaskArtifact(opts.taskId, "test-results.json", testResult, root);
        await persistTaskState(opts.taskId, stateMachine, root);
        if (stateMachine.getState().stage === "coding") {
          feedback = { kind: "test_failure", testResult };
        }
        continue;
      }

      if (stage === "review") {
        reviewResult = await runReviewPhase({
          taskId: opts.taskId,
          plan,
          diff,
          rubricText,
          stateMachine,
          reviewerClient: opts.reviewerClient,
        });
        await writeTaskArtifact(opts.taskId, "review.json", reviewResult, root);
        await persistTaskState(opts.taskId, stateMachine, root);
        if (stateMachine.getState().stage === "coding") {
          feedback = { kind: "review_findings", reviewResult };
        }
        continue;
      }

      if (stage === "human_gate") {
        // testResult is always set by the time human_gate is reachable:
        // every path into it (REVIEW_CLEAN, or a loopToCoding escalation
        // from testing or review) passes through "testing" first.
        const decision = await opts.humanGateChannel.requestDecision({
          taskId: opts.taskId,
          plan,
          diff,
          testResult: testResult!,
          reviewResult,
          taskState: stateMachine.getState(),
        });
        const round = humanGateLog.length;
        humanGateLog.push({ round, decision, timestamp: new Date().toISOString() });
        await writeTaskArtifact(opts.taskId, "human-gate-log.json", humanGateLog, root);

        const stepId = `${opts.taskId}:human_gate:${decision.type}:round-${round}`;
        if (decision.type === "approved") {
          stateMachine.apply(stepId, { type: "HUMAN_APPROVED" });
        } else if (decision.type === "rejected") {
          stateMachine.apply(stepId, { type: "HUMAN_REJECTED", reason: decision.reason });
        } else {
          stateMachine.apply(stepId, { type: "HUMAN_REQUESTED_CHANGES" });
          feedback = { kind: "human_feedback", feedback: decision.feedback };
        }
        await persistTaskState(opts.taskId, stateMachine, root);
        continue;
      }

      // "done" or "failed" — the loop's only exit under normal operation.
      return stateMachine.getState();
    }
  } catch (error) {
    // Guardrails inside the phase functions already apply STAGE_FAILED
    // for the failure modes they know about. Anything else (an agent call
    // erroring, a git or test-command operation failing) wouldn't have —
    // mark the task failed here too, so task-state.json never says
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
