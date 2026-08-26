import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTask } from "../src/taskRunner.js";
import { PlanningPhaseFailedError } from "../src/planningPhase.js";
import type { PlannerAgentClient, PlannerAgentInput } from "../src/agents/plannerAgent.js";
import type { CoderAgentClient, CoderAgentInput, CoderAgentResult } from "../src/agents/coderAgent.js";
import type { TestAuthorAgentClient, TestAuthorAgentInput, TestAuthorResult } from "../src/agents/testAuthorAgent.js";
import type { TestResultAgentClient, TestResultAgentInput } from "../src/agents/testResultAgent.js";
import type { ReviewerAgentClient, ReviewerAgentInput } from "../src/agents/reviewerAgent.js";
import type { HumanInteractionChannel } from "../src/humanInteraction.js";
import type { ProjectConfig } from "../src/projectConfig.js";
import type { PlannerAnswer, PlannerQuestion, PlannerTurn, ReviewResult, TestResult } from "../src/types.js";

const projectConfig: ProjectConfig = {
  name: "test-project",
  repo: {},
  rubric: { path: "rubrics/legibility-default.md" },
  stack: { testCommand: 'node -e "process.exit(0)"' },
  budget: {
    maxTokensPerTask: 1_000_000,
    maxCostUsdPerTask: 100,
    maxFixReviewCycles: 3,
    maxPlanningQuestionRounds: 2,
    maxCoderTurns: 5,
    maxTesterTurns: 5,
    testCommandTimeoutMs: 10_000,
  },
};

const samplePlan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

class ScriptedPlannerClient implements PlannerAgentClient {
  private callIndex = 0;
  constructor(private readonly turns: PlannerTurn[]) {}

  async runTurn(_input: PlannerAgentInput): Promise<PlannerTurn> {
    const turn = this.turns[this.callIndex];
    this.callIndex += 1;
    return turn;
  }
}

class ScriptedInteractionChannel implements HumanInteractionChannel {
  private callIndex = 0;
  constructor(private readonly answers: PlannerAnswer[][]) {}

  async askPlanningQuestions(_questions: PlannerQuestion[]): Promise<PlannerAnswer[]> {
    const answer = this.answers[this.callIndex];
    this.callIndex += 1;
    return answer;
  }
}

class ScriptedCoderClient implements CoderAgentClient {
  constructor(
    private readonly result: CoderAgentResult,
    private readonly onRun?: (input: CoderAgentInput) => void,
  ) {}

  async runCoding(input: CoderAgentInput): Promise<CoderAgentResult> {
    this.onRun?.(input);
    return this.result;
  }
}

class ScriptedTestAuthorClient implements TestAuthorAgentClient {
  constructor(private readonly onRun?: (input: TestAuthorAgentInput) => void) {}

  async runAuthoring(input: TestAuthorAgentInput): Promise<TestAuthorResult> {
    this.onRun?.(input);
    return { summary: "wrote tests", totalCostUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

class ScriptedTestResultClient implements TestResultAgentClient {
  constructor(private readonly result: TestResult) {}

  async runInterpretation(_input: TestResultAgentInput): Promise<TestResult> {
    return this.result;
  }
}

class ScriptedReviewerClient implements ReviewerAgentClient {
  constructor(private readonly result: ReviewResult) {}

  async runReview(_input: ReviewerAgentInput): Promise<ReviewResult> {
    return this.result;
  }
}

const noopCoderClient = new ScriptedCoderClient({
  summary: "done",
  totalCostUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
});
const noopTestAuthorClient = new ScriptedTestAuthorClient();
const passingTestResultClient = new ScriptedTestResultClient({
  taskId: "task-1",
  results: [{ criterionId: "a1", passed: true }],
  testsRun: [],
});
const cleanReviewerClient = new ScriptedReviewerClient({ taskId: "task-1", findings: [], confidence: 0.95 });

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("runTask", () => {
  it("runs the full pipeline to a clean review, writing every artifact and landing at human_gate", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const coderClient = new ScriptedCoderClient(
      { summary: "implemented", totalCostUsd: 0.02, usage: { inputTokens: 10, outputTokens: 20 } },
      (input) => {
        writeFileSync(path.join(input.repoDir, "x.ts"), "export const x = 1;\n", "utf-8");
      },
    );
    const testAuthorClient = new ScriptedTestAuthorClient((input) => {
      writeFileSync(path.join(input.repoDir, "x.test.ts"), "test('a1', () => {});\n", "utf-8");
    });

    const state = await runTask({
      taskId: "task-1",
      requirement: "add x",
      projectConfig,
      plannerClient,
      coderClient,
      testAuthorClient,
      testResultClient: passingTestResultClient,
      reviewerClient: cleanReviewerClient,
      interactionChannel,
      workspaceRoot: tempDir,
    });

    expect(state.stage).toBe("human_gate");
    expect(state.status).toBe("in_progress");
    expect(state.escalated).toBe(false);

    const taskDir = path.join(tempDir, "task-1");
    const plan = JSON.parse(readFileSync(path.join(taskDir, "plan.json"), "utf-8"));
    expect(plan).toEqual(samplePlan);

    const transcript = JSON.parse(readFileSync(path.join(taskDir, "planning-transcript.json"), "utf-8"));
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ round: 0, kind: "turn" });

    const diff = readFileSync(path.join(taskDir, "diff.patch"), "utf-8");
    expect(diff).toContain("x.ts");
    expect(diff).toContain("x.test.ts");

    const testResults = JSON.parse(readFileSync(path.join(taskDir, "test-results.json"), "utf-8"));
    expect(testResults.results).toEqual([{ criterionId: "a1", passed: true }]);

    const review = JSON.parse(readFileSync(path.join(taskDir, "review.json"), "utf-8"));
    expect(review.findings).toEqual([]);

    const persistedState = JSON.parse(readFileSync(path.join(taskDir, "task-state.json"), "utf-8"));
    expect(persistedState.stage).toBe("human_gate");
  });

  it("stops at coding when tests fail, without invoking the Reviewer", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const failingTestResultClient = new ScriptedTestResultClient({
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: false, reason: "assertion failed" }],
      testsRun: [],
    });
    let reviewerCalled = false;
    const reviewerClient: ReviewerAgentClient = {
      async runReview(): Promise<ReviewResult> {
        reviewerCalled = true;
        return { taskId: "task-1", findings: [], confidence: 1 };
      },
    };

    const state = await runTask({
      taskId: "task-1",
      requirement: "add x",
      projectConfig,
      plannerClient,
      coderClient: noopCoderClient,
      testAuthorClient: noopTestAuthorClient,
      testResultClient: failingTestResultClient,
      reviewerClient,
      interactionChannel,
      workspaceRoot: tempDir,
    });

    expect(state.stage).toBe("coding");
    expect(reviewerCalled).toBe(false);

    const taskDir = path.join(tempDir, "task-1");
    expect(existsSync(path.join(taskDir, "review.json"))).toBe(false);
    expect(existsSync(path.join(taskDir, "test-results.json"))).toBe(true);
  });

  it("marks the task failed and writes no plan.json once question rounds are exhausted", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const questionsTurn: PlannerTurn = {
      taskId: "task-1",
      type: "questions",
      questions: [{ id: "q1", header: "H", question: "Q?", options: [{ label: "A" }, { label: "B" }] }],
    };
    const plannerClient = new ScriptedPlannerClient([questionsTurn, questionsTurn]);
    const answers: PlannerAnswer[] = [{ questionId: "q1", selectedLabel: "A" }];
    const interactionChannel = new ScriptedInteractionChannel([answers]);

    await expect(
      runTask({
        taskId: "task-1",
        requirement: "add x",
        projectConfig: {
          ...projectConfig,
          budget: { ...projectConfig.budget, maxPlanningQuestionRounds: 1 },
        },
        plannerClient,
        coderClient: noopCoderClient,
        testAuthorClient: noopTestAuthorClient,
        testResultClient: passingTestResultClient,
        reviewerClient: cleanReviewerClient,
        interactionChannel,
        workspaceRoot: tempDir,
      }),
    ).rejects.toThrow(PlanningPhaseFailedError);

    const taskDir = path.join(tempDir, "task-1");
    expect(existsSync(path.join(taskDir, "plan.json"))).toBe(false);

    const persistedState = JSON.parse(readFileSync(path.join(taskDir, "task-state.json"), "utf-8"));
    expect(persistedState.stage).toBe("failed");
    expect(persistedState.failureReason).toBe("planning_question_rounds_exhausted");
  });

  it("marks the task failed when the planner client throws an error runPlanningPhase doesn't itself handle", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient: PlannerAgentClient = {
      async runTurn(): Promise<PlannerTurn> {
        throw new Error("network error");
      },
    };
    const interactionChannel = new ScriptedInteractionChannel([]);

    await expect(
      runTask({
        taskId: "task-1",
        requirement: "add x",
        projectConfig,
        plannerClient,
        coderClient: noopCoderClient,
        testAuthorClient: noopTestAuthorClient,
        testResultClient: passingTestResultClient,
        reviewerClient: cleanReviewerClient,
        interactionChannel,
        workspaceRoot: tempDir,
      }),
    ).rejects.toThrow("network error");

    const taskDir = path.join(tempDir, "task-1");
    const persistedState = JSON.parse(readFileSync(path.join(taskDir, "task-state.json"), "utf-8"));
    expect(persistedState.stage).toBe("failed");
    expect(persistedState.failureReason).toBe("network error");
  });

  it("marks the task failed when the coder client throws", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const coderClient: CoderAgentClient = {
      async runCoding(): Promise<CoderAgentResult> {
        throw new Error("coder session failed");
      },
    };

    await expect(
      runTask({
        taskId: "task-1",
        requirement: "add x",
        projectConfig,
        plannerClient,
        coderClient,
        testAuthorClient: noopTestAuthorClient,
        testResultClient: passingTestResultClient,
        reviewerClient: cleanReviewerClient,
        interactionChannel,
        workspaceRoot: tempDir,
      }),
    ).rejects.toThrow("coder session failed");

    const taskDir = path.join(tempDir, "task-1");
    const persistedState = JSON.parse(readFileSync(path.join(taskDir, "task-state.json"), "utf-8"));
    expect(persistedState.stage).toBe("failed");
    expect(persistedState.failureReason).toBe("coder session failed");
    expect(existsSync(path.join(taskDir, "diff.patch"))).toBe(false);
  });
});
