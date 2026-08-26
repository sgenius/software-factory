import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, parseProjectConfig, ProjectConfigError } from "../src/projectConfig.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const validYaml = `
name: example-project
repo:
  source: git@github.com:example-org/example-project.git
  defaultBranch: main
rubric:
  path: rubrics/legibility-default.md
stack:
  testCommand: npm test
budget:
  maxTokensPerTask: 2000000
  maxCostUsdPerTask: 20
  maxFixReviewCycles: 3
  maxPlanningQuestionRounds: 3
  maxCoderTurns: 20
  maxTesterTurns: 20
  testCommandTimeoutMs: 300000
`;

describe("parseProjectConfig", () => {
  it("extracts name, repo, rubric, stack, and budget fields from valid YAML", () => {
    const config = parseProjectConfig(validYaml);
    expect(config).toEqual({
      name: "example-project",
      repo: {
        source: "git@github.com:example-org/example-project.git",
        defaultBranch: "main",
      },
      rubric: { path: "rubrics/legibility-default.md" },
      stack: { testCommand: "npm test" },
      budget: {
        maxTokensPerTask: 2000000,
        maxCostUsdPerTask: 20,
        maxFixReviewCycles: 3,
        maxPlanningQuestionRounds: 3,
        maxCoderTurns: 20,
        maxTesterTurns: 20,
        testCommandTimeoutMs: 300000,
      },
    });
  });

  it("defaults repo to {} and rubric.path to the shared default when omitted", () => {
    const yaml = `
name: new-project
stack:
  testCommand: npm test
budget:
  maxTokensPerTask: 1
  maxCostUsdPerTask: 1
  maxFixReviewCycles: 1
  maxPlanningQuestionRounds: 1
  maxCoderTurns: 1
  maxTesterTurns: 1
  testCommandTimeoutMs: 1
`;
    const config = parseProjectConfig(yaml);
    expect(config.repo).toEqual({ source: undefined, defaultBranch: undefined });
    expect(config.rubric).toEqual({ path: "rubrics/legibility-default.md" });
  });

  it("throws a clear error when budget is missing", () => {
    const yaml = "name: x\nstack:\n  testCommand: npm test\n";
    expect(() => parseProjectConfig(yaml)).toThrow(ProjectConfigError);
    expect(() => parseProjectConfig(yaml)).toThrow(/budget/);
  });

  it("throws a clear error when stack is missing", () => {
    const yaml = `
name: x
budget:
  maxTokensPerTask: 1
  maxCostUsdPerTask: 1
  maxFixReviewCycles: 1
  maxPlanningQuestionRounds: 1
  maxCoderTurns: 1
  maxTesterTurns: 1
  testCommandTimeoutMs: 1
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/stack/);
  });

  it("throws a clear error when stack.testCommand is missing", () => {
    const yaml = `
name: x
stack: {}
budget:
  maxTokensPerTask: 1
  maxCostUsdPerTask: 1
  maxFixReviewCycles: 1
  maxPlanningQuestionRounds: 1
  maxCoderTurns: 1
  maxTesterTurns: 1
  testCommandTimeoutMs: 1
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/testCommand/);
  });

  it("throws a clear error when a budget field is non-numeric", () => {
    const yaml = `
name: x
stack:
  testCommand: npm test
budget:
  maxTokensPerTask: "a lot"
  maxCostUsdPerTask: 20
  maxFixReviewCycles: 3
  maxPlanningQuestionRounds: 3
  maxCoderTurns: 20
  maxTesterTurns: 20
  testCommandTimeoutMs: 300000
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/maxTokensPerTask/);
  });

  it("throws a clear error when maxTesterTurns is missing", () => {
    const yaml = `
name: x
stack:
  testCommand: npm test
budget:
  maxTokensPerTask: 1
  maxCostUsdPerTask: 1
  maxFixReviewCycles: 1
  maxPlanningQuestionRounds: 1
  maxCoderTurns: 1
  testCommandTimeoutMs: 1
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/maxTesterTurns/);
  });

  it("throws a clear error when name is missing", () => {
    const yaml = `
stack:
  testCommand: npm test
budget:
  maxTokensPerTask: 1
  maxCostUsdPerTask: 1
  maxFixReviewCycles: 1
  maxPlanningQuestionRounds: 1
  maxCoderTurns: 1
  maxTesterTurns: 1
  testCommandTimeoutMs: 1
`;
    expect(() => parseProjectConfig(yaml)).toThrow(/name/);
  });
});

describe("loadProjectConfig", () => {
  it("parses the real projects/example-project.yaml this repo ships", () => {
    const config = loadProjectConfig(path.join(REPO_ROOT, "projects/example-project.yaml"));
    expect(config.name).toBe("example-project");
    expect(config.repo).toEqual({
      source: "git@github.com:example-org/example-project.git",
      defaultBranch: "main",
    });
    expect(config.rubric).toEqual({ path: "rubrics/legibility-default.md" });
    expect(config.stack).toEqual({ testCommand: "npm test" });
    expect(config.budget).toEqual({
      maxTokensPerTask: 2000000,
      maxCostUsdPerTask: 20,
      maxFixReviewCycles: 3,
      maxPlanningQuestionRounds: 3,
      maxCoderTurns: 20,
      maxTesterTurns: 20,
      testCommandTimeoutMs: 300000,
    });
  });
});
