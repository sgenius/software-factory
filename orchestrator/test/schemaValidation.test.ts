import { describe, expect, it } from "vitest";
import { validatePlan, validatePlannerTurn } from "../src/schemaValidation.js";

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
