import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, parseProjectConfig, ProjectConfigError } from "../src/projectConfig.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const validYaml = `
name: example-project
budget:
  maxTokensPerTask: 2000000
  maxCostUsdPerTask: 20
  maxFixReviewCycles: 3
  maxPlanningQuestionRounds: 3
`;

describe("parseProjectConfig", () => {
  it("extracts name and budget fields from valid YAML", () => {
    const config = parseProjectConfig(validYaml);
    expect(config).toEqual({
      name: "example-project",
      budget: {
        maxTokensPerTask: 2000000,
        maxCostUsdPerTask: 20,
        maxFixReviewCycles: 3,
        maxPlanningQuestionRounds: 3,
      },
    });
  });

  it("throws a clear error when budget is missing", () => {
    expect(() => parseProjectConfig("name: x\n")).toThrow(ProjectConfigError);
    expect(() => parseProjectConfig("name: x\n")).toThrow(/budget/);
  });

  it("throws a clear error when a budget field is non-numeric", () => {
    const yaml = `
name: x
budget:
  maxTokensPerTask: "a lot"
  maxCostUsdPerTask: 20
  maxFixReviewCycles: 3
  maxPlanningQuestionRounds: 3
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/maxTokensPerTask/);
  });

  it("throws a clear error when name is missing", () => {
    const yaml = `
budget:
  maxTokensPerTask: 1
  maxCostUsdPerTask: 1
  maxFixReviewCycles: 1
  maxPlanningQuestionRounds: 1
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/name/);
  });
});

describe("loadProjectConfig", () => {
  it("parses the real projects/example-project.yaml this repo ships", () => {
    const config = loadProjectConfig(path.join(REPO_ROOT, "projects/example-project.yaml"));
    expect(config.name).toBe("example-project");
    expect(config.budget).toEqual({
      maxTokensPerTask: 2000000,
      maxCostUsdPerTask: 20,
      maxFixReviewCycles: 3,
      maxPlanningQuestionRounds: 3,
    });
  });
});
