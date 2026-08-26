import { describe, expect, it } from "vitest";
import {
  PlanningPhaseFailedError,
  runPlanningPhase,
  type PlanningTranscriptEntry,
} from "../src/planningPhase.js";
import { TaskStateMachine } from "../src/stateMachine.js";
import type { PlannerAgentClient, PlannerAgentInput } from "../src/agents/plannerAgent.js";
import type { HumanInteractionChannel } from "../src/humanInteraction.js";
import type { Plan, PlannerAnswer, PlannerQuestion, PlannerTurn } from "../src/types.js";

function makeStateMachine(): TaskStateMachine {
  return new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
}

const samplePlan: Plan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

const sampleQuestion: PlannerQuestion = {
  id: "q1",
  header: "Auth method",
  question: "Which auth method?",
  options: [
    { label: "JWT (Recommended)", description: "stateless" },
    { label: "Session cookies" },
    { label: "Let the agent decide" },
  ],
};

class ScriptedPlannerClient implements PlannerAgentClient {
  private callIndex = 0;
  public readonly receivedInputs: PlannerAgentInput[] = [];

  constructor(private readonly turns: PlannerTurn[]) {}

  async runTurn(input: PlannerAgentInput): Promise<PlannerTurn> {
    this.receivedInputs.push(input);
    const turn = this.turns[this.callIndex];
    this.callIndex += 1;
    return turn;
  }
}

class ScriptedInteractionChannel implements HumanInteractionChannel {
  public readonly askedQuestions: PlannerQuestion[][] = [];

  constructor(private readonly answers: PlannerAnswer[][]) {}

  async askPlanningQuestions(questions: PlannerQuestion[]): Promise<PlannerAnswer[]> {
    this.askedQuestions.push(questions);
    return this.answers[this.askedQuestions.length - 1];
  }
}

function collectingTranscript() {
  const entries: PlanningTranscriptEntry[] = [];
  return {
    entries,
    persistTranscript: async (entry: PlanningTranscriptEntry) => {
      entries.push(entry);
    },
  };
}

describe("runPlanningPhase", () => {
  it("returns the plan directly when the Planner has no questions", async () => {
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const { entries, persistTranscript } = collectingTranscript();

    const plan = await runPlanningPhase({
      taskId: "task-1",
      requirement: "add x",
      stateMachine: makeStateMachine(),
      plannerClient,
      interactionChannel,
      maxQuestionRounds: 3,
      persistTranscript,
    });

    expect(plan).toEqual(samplePlan);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ round: 0, kind: "turn" });
  });

  it("asks the human, feeds answers back into the next turn, and returns the resulting plan", async () => {
    const questionsTurn: PlannerTurn = { taskId: "task-1", type: "questions", questions: [sampleQuestion] };
    const planTurn: PlannerTurn = { taskId: "task-1", type: "plan", plan: samplePlan };
    const plannerClient = new ScriptedPlannerClient([questionsTurn, planTurn]);
    const answers: PlannerAnswer[] = [{ questionId: "q1", selectedLabel: "JWT (Recommended)" }];
    const interactionChannel = new ScriptedInteractionChannel([answers]);
    const { entries, persistTranscript } = collectingTranscript();

    const plan = await runPlanningPhase({
      taskId: "task-1",
      requirement: "add x",
      stateMachine: makeStateMachine(),
      plannerClient,
      interactionChannel,
      maxQuestionRounds: 3,
      persistTranscript,
    });

    expect(plan).toEqual(samplePlan);
    expect(interactionChannel.askedQuestions).toEqual([[sampleQuestion]]);
    expect(plannerClient.receivedInputs[1].priorAnswers).toEqual(answers);
    expect(entries.map((entry) => entry.kind)).toEqual(["turn", "answers", "turn"]);
  });

  it("fails the task once question rounds exceed the cap", async () => {
    const questionsTurn: PlannerTurn = { taskId: "task-1", type: "questions", questions: [sampleQuestion] };
    const plannerClient = new ScriptedPlannerClient([questionsTurn, questionsTurn]);
    const answers: PlannerAnswer[] = [{ questionId: "q1", selectedLabel: "JWT (Recommended)" }];
    const interactionChannel = new ScriptedInteractionChannel([answers]);
    const { persistTranscript } = collectingTranscript();
    const stateMachine = makeStateMachine();

    await expect(
      runPlanningPhase({
        taskId: "task-1",
        requirement: "add x",
        stateMachine,
        plannerClient,
        interactionChannel,
        maxQuestionRounds: 1,
        persistTranscript,
      }),
    ).rejects.toThrow(PlanningPhaseFailedError);

    const state = stateMachine.getState();
    expect(state.stage).toBe("failed");
    expect(state.failureReason).toBe("planning_question_rounds_exhausted");
  });
});
