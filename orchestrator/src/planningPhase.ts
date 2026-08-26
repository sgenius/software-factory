import { assertValid, validatePlan } from "./schemaValidation.js";
import type { TaskStateMachine } from "./stateMachine.js";
import type { HumanInteractionChannel } from "./humanInteraction.js";
import type { PlannerAgentClient } from "./agents/plannerAgent.js";
import type { Plan, PlannerAnswer, PlannerTurn } from "./types.js";

export type PlanningTranscriptEntry =
  | { round: number; kind: "turn"; turn: PlannerTurn }
  | { round: number; kind: "answers"; answers: PlannerAnswer[] };

export interface PlanningPhaseOptions {
  taskId: string;
  requirement: string;
  stateMachine: TaskStateMachine;
  plannerClient: PlannerAgentClient;
  interactionChannel: HumanInteractionChannel;
  /** Guardrail parallel to TaskStateMachine's fix/review cycle cap: how many times the Planner may ask the human before the task fails. */
  maxQuestionRounds: number;
  persistTranscript: (entry: PlanningTranscriptEntry) => Promise<void>;
}

export class PlanningPhaseFailedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "PlanningPhaseFailedError";
  }
}

/**
 * Drives the Planner through as many question rounds as it needs, then
 * returns the finished Plan. Runs entirely inside the state machine's
 * "planning" stage — TaskStateMachine gains no new stages/events for this;
 * the caller applies PLAN_READY once this resolves.
 */
export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<Plan> {
  let answers: PlannerAnswer[] = [];
  let questionRounds = 0;

  while (true) {
    const turn = await opts.plannerClient.runTurn({
      taskId: opts.taskId,
      requirement: opts.requirement,
      priorAnswers: answers,
    });
    await opts.persistTranscript({ round: questionRounds, kind: "turn", turn });

    if (turn.type === "plan") {
      assertValid(validatePlan, "plan", turn.plan);
      return turn.plan;
    }

    questionRounds += 1;
    if (questionRounds > opts.maxQuestionRounds) {
      const reason = "planning_question_rounds_exhausted";
      opts.stateMachine.apply(`${opts.taskId}:planning:round:${questionRounds}:exhausted`, {
        type: "STAGE_FAILED",
        reason,
      });
      throw new PlanningPhaseFailedError(
        `Planning phase for task ${opts.taskId} exceeded ${opts.maxQuestionRounds} question rounds`,
        reason,
      );
    }

    const newAnswers = await opts.interactionChannel.askPlanningQuestions(turn.questions);
    await opts.persistTranscript({ round: questionRounds, kind: "answers", answers: newAnswers });
    answers = [...answers, ...newAnswers];
  }
}
