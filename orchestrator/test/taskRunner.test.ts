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
import type { HumanGateChannel, HumanGateDecision, HumanGateRequest } from "../src/humanGate.js";
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
  public receivedInputs: CoderAgentInput[] = [];

  constructor(
    private readonly result: CoderAgentResult,
    private readonly onRun?: (input: CoderAgentInput) => void,
  ) {}

  async runCoding(input: CoderAgentInput): Promise<CoderAgentResult> {
    this.receivedInputs.push(input);
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

class ScriptedHumanGateChannel implements HumanGateChannel {
  private callIndex = 0;
  public receivedRequests: HumanGateRequest[] = [];

  constructor(private readonly decisions: HumanGateDecision[]) {}

  async requestDecision(request: HumanGateRequest): Promise<HumanGateDecision> {
    this.receivedRequests.push(request);
    const decision = this.decisions[this.callIndex];
    this.callIndex += 1;
    return decision;
  }
}

const passingResult: TestResult = { taskId: "task-1", results: [{ criterionId: "a1", passed: true }], testsRun: [] };
const failingResult: TestResult = {
  taskId: "task-1",
  results: [{ criterionId: "a1", passed: false, reason: "assertion failed" }],
  testsRun: [],
};

const noopCoderClient = new ScriptedCoderClient({
  summary: "done",
  totalCostUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
});
const noopTestAuthorClient = new ScriptedTestAuthorClient();
const passingTestResultClient = new ScriptedTestResultClient(passingResult);
const cleanReviewerClient = new ScriptedReviewerClient({ taskId: "task-1", findings: [], confidence: 0.95 });
const approveGateChannel = new ScriptedHumanGateChannel([{ type: "approved" }]);

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("runTask", () => {
  it("runs the full pipeline to done: plan, code, pass, clean review, human approves", async () => {
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
    const humanGateChannel = new ScriptedHumanGateChannel([{ type: "approved" }]);

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
      humanGateChannel,
      workspaceRoot: tempDir,
    });

    expect(state.stage).toBe("done");
    expect(state.status).toBe("done");

    const taskDir = path.join(tempDir, "task-1");
    const plan = JSON.parse(readFileSync(path.join(taskDir, "plan.json"), "utf-8"));
    expect(plan).toEqual(samplePlan);

    const diff = readFileSync(path.join(taskDir, "diff.patch"), "utf-8");
    expect(diff).toContain("x.ts");
    expect(diff).toContain("x.test.ts");

    const testResults = JSON.parse(readFileSync(path.join(taskDir, "test-results.json"), "utf-8"));
    expect(testResults.results).toEqual([{ criterionId: "a1", passed: true }]);

    const review = JSON.parse(readFileSync(path.join(taskDir, "review.json"), "utf-8"));
    expect(review.findings).toEqual([]);

    const gateLog = JSON.parse(readFileSync(path.join(taskDir, "human-gate-log.json"), "utf-8"));
    expect(gateLog).toHaveLength(1);
    expect(gateLog[0].decision).toEqual({ type: "approved" });

    const persistedState = JSON.parse(readFileSync(path.join(taskDir, "task-state.json"), "utf-8"));
    expect(persistedState.stage).toBe("done");
  });

  it("retries Coder with test-failure feedback, then succeeds through to done", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const coderClient = new ScriptedCoderClient({
      summary: "fixed",
      totalCostUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    let testCall = 0;
    const testResultClient: TestResultAgentClient = {
      async runInterpretation(): Promise<TestResult> {
        testCall += 1;
        return testCall === 1 ? failingResult : passingResult;
      },
    };
    const humanGateChannel = new ScriptedHumanGateChannel([{ type: "approved" }]);

    const state = await runTask({
      taskId: "task-1",
      requirement: "add x",
      projectConfig,
      plannerClient,
      coderClient,
      testAuthorClient: noopTestAuthorClient,
      testResultClient,
      reviewerClient: cleanReviewerClient,
      interactionChannel,
      humanGateChannel,
      workspaceRoot: tempDir,
    });

    expect(state.stage).toBe("done");
    expect(state.fixReviewCycles).toBe(1);
    expect(coderClient.receivedInputs).toHaveLength(2);
    expect(coderClient.receivedInputs[0].priorFeedback).toBeUndefined();
    expect(coderClient.receivedInputs[1].priorFeedback).toEqual({ kind: "test_failure", testResult: failingResult });
  });

  it("retries Coder with human feedback after a requested-changes decision, then approves", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const coderClient = new ScriptedCoderClient({
      summary: "adjusted",
      totalCostUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const humanGateChannel = new ScriptedHumanGateChannel([
      { type: "requested_changes", feedback: "please rename the export" },
      { type: "approved" },
    ]);

    const state = await runTask({
      taskId: "task-1",
      requirement: "add x",
      projectConfig,
      plannerClient,
      coderClient,
      testAuthorClient: noopTestAuthorClient,
      testResultClient: passingTestResultClient,
      reviewerClient: cleanReviewerClient,
      interactionChannel,
      humanGateChannel,
      workspaceRoot: tempDir,
    });

    expect(state.stage).toBe("done");
    expect(coderClient.receivedInputs).toHaveLength(2);
    expect(coderClient.receivedInputs[1].priorFeedback).toEqual({
      kind: "human_feedback",
      feedback: "please rename the export",
    });

    const taskDir = path.join(tempDir, "task-1");
    const gateLog = JSON.parse(readFileSync(path.join(taskDir, "human-gate-log.json"), "utf-8"));
    expect(gateLog).toHaveLength(2);
    expect(gateLog[0].decision.type).toBe("requested_changes");
    expect(gateLog[1].decision.type).toBe("approved");
  });

  it("fails the task with the human's reason when rejected", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const humanGateChannel = new ScriptedHumanGateChannel([{ type: "rejected", reason: "not what we asked for" }]);

    const state = await runTask({
      taskId: "task-1",
      requirement: "add x",
      projectConfig,
      plannerClient,
      coderClient: noopCoderClient,
      testAuthorClient: noopTestAuthorClient,
      testResultClient: passingTestResultClient,
      reviewerClient: cleanReviewerClient,
      interactionChannel,
      humanGateChannel,
      workspaceRoot: tempDir,
    });

    expect(state.stage).toBe("failed");
    expect(state.failureReason).toBe("not what we asked for");
  });

  it("escalates to the human gate on repeated test failures without ever reaching review", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
    const plannerClient = new ScriptedPlannerClient([{ taskId: "task-1", type: "plan", plan: samplePlan }]);
    const interactionChannel = new ScriptedInteractionChannel([]);
    const alwaysFailingTestResultClient = new ScriptedTestResultClient(failingResult);
    let reviewerCalled = false;
    const reviewerClient: ReviewerAgentClient = {
      async runReview(): Promise<ReviewResult> {
        reviewerCalled = true;
        return { taskId: "task-1", findings: [], confidence: 1 };
      },
    };
    const humanGateChannel = new ScriptedHumanGateChannel([{ type: "rejected" }]);

    const state = await runTask({
      taskId: "task-1",
      requirement: "add x",
      projectConfig: { ...projectConfig, budget: { ...projectConfig.budget, maxFixReviewCycles: 1 } },
      plannerClient,
      coderClient: noopCoderClient,
      testAuthorClient: noopTestAuthorClient,
      testResultClient: alwaysFailingTestResultClient,
      reviewerClient,
      interactionChannel,
      humanGateChannel,
      workspaceRoot: tempDir,
    });

    expect(state.escalated).toBe(true);
    expect(state.stage).toBe("failed");
    expect(reviewerCalled).toBe(false);
    expect(humanGateChannel.receivedRequests).toHaveLength(1);
    expect(humanGateChannel.receivedRequests[0].reviewResult).toBeUndefined();

    const taskDir = path.join(tempDir, "task-1");
    expect(existsSync(path.join(taskDir, "review.json"))).toBe(false);
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
        humanGateChannel: approveGateChannel,
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
        humanGateChannel: approveGateChannel,
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
        humanGateChannel: approveGateChannel,
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
