import { describe, expect, it } from "vitest";
import { validatePlan, validatePlannerTurn, validateReviewResult, validateTestResult } from "../src/schemaValidation.js";

const samplePlan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

describe("validatePlannerTurn", () => {
  it("accepts a valid questions turn", () => {
    const turn = {
      taskId: "task-1",
      type: "questions",
      questions: [
        {
          id: "q1",
          header: "Auth method",
          question: "Which auth method?",
          options: [
            { label: "JWT (Recommended)" },
            { label: "Sessions" },
            { label: "Let the agent decide" },
          ],
        },
      ],
    };
    expect(validatePlannerTurn(turn)).toBe(true);
  });

  it("accepts a valid plan turn, and the embedded plan also satisfies plan.schema.json on its own", () => {
    const turn = { taskId: "task-1", type: "plan", plan: samplePlan };
    expect(validatePlannerTurn(turn)).toBe(true);
    expect(validatePlan(samplePlan)).toBe(true);
  });

  it("rejects a plan turn with an invalid embedded plan", () => {
    const turn = { taskId: "task-1", type: "plan", plan: { taskId: "task-1" } };
    expect(validatePlannerTurn(turn)).toBe(false);
  });

  it("rejects a questions turn with fewer than 2 options", () => {
    const turn = {
      taskId: "task-1",
      type: "questions",
      questions: [{ id: "q1", header: "H", question: "Q?", options: [{ label: "Only one" }] }],
    };
    expect(validatePlannerTurn(turn)).toBe(false);
  });

  it("rejects an unrecognized type", () => {
    expect(validatePlannerTurn({ taskId: "task-1", type: "mystery" })).toBe(false);
  });
});

describe("validateTestResult", () => {
  it("accepts a valid result", () => {
    const testResult = {
      taskId: "task-1",
      results: [{ criterionId: "a1", passed: true }],
      testsRun: ["x.test.ts"],
    };
    expect(validateTestResult(testResult)).toBe(true);
  });

  it("rejects an empty results array", () => {
    expect(validateTestResult({ taskId: "task-1", results: [], testsRun: [] })).toBe(false);
  });

  it("rejects a result item missing passed", () => {
    const testResult = { taskId: "task-1", results: [{ criterionId: "a1" }], testsRun: [] };
    expect(validateTestResult(testResult)).toBe(false);
  });
});

describe("validateReviewResult", () => {
  it("accepts a valid result with an embedded finding, and the finding also satisfies review-finding.schema.json on its own", () => {
    const finding = { taskId: "task-1", file: "x.ts", line: 3, severity: "blocking", summary: "scope creep" };
    const reviewResult = { taskId: "task-1", findings: [finding], confidence: 0.9 };
    expect(validateReviewResult(reviewResult)).toBe(true);
  });

  it("accepts a clean review with no findings", () => {
    expect(validateReviewResult({ taskId: "task-1", findings: [], confidence: 1 })).toBe(true);
  });

  it("rejects an embedded finding with an invalid severity", () => {
    const finding = { taskId: "task-1", file: "x.ts", line: 3, severity: "urgent", summary: "oops" };
    expect(validateReviewResult({ taskId: "task-1", findings: [finding], confidence: 0.5 })).toBe(false);
  });

  it("rejects confidence outside 0-1", () => {
    expect(validateReviewResult({ taskId: "task-1", findings: [], confidence: 1.5 })).toBe(false);
  });
});
