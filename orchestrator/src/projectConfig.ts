import { readFileSync } from "node:fs";
import { parse } from "yaml";

const DEFAULT_RUBRIC_PATH = "rubrics/legibility-default.md";

export interface ProjectConfig {
  name: string;
  repo: {
    source?: string;
    defaultBranch?: string;
  };
  rubric: {
    path: string;
  };
  budget: {
    maxTokensPerTask: number;
    maxCostUsdPerTask: number;
    maxFixReviewCycles: number;
    maxPlanningQuestionRounds: number;
    maxCoderTurns: number;
  };
}

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

function requireNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ProjectConfigError(`Project config field "${fieldPath}" must be a number, got: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectConfigError(`Project config field "${fieldPath}" must be a non-empty string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, fieldPath);
}

/** Extracts and validates only the fields this codebase currently reads — pure, no file I/O. */
export function parseProjectConfig(yamlText: string): ProjectConfig {
  const raw = parse(yamlText) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") {
    throw new ProjectConfigError("Project config must be a YAML mapping");
  }

  const name = requireString(raw.name, "name");

  const budget = raw.budget as Record<string, unknown> | undefined;
  if (typeof budget !== "object" || budget === null) {
    throw new ProjectConfigError('Project config is missing the "budget" section');
  }

  const repo = (raw.repo as Record<string, unknown> | undefined) ?? {};
  const rubric = (raw.rubric as Record<string, unknown> | undefined) ?? {};

  return {
    name,
    repo: {
      source: optionalString(repo.source, "repo.source"),
      defaultBranch: optionalString(repo.defaultBranch, "repo.defaultBranch"),
    },
    rubric: {
      path: rubric.path === undefined ? DEFAULT_RUBRIC_PATH : requireString(rubric.path, "rubric.path"),
    },
    budget: {
      maxTokensPerTask: requireNumber(budget.maxTokensPerTask, "budget.maxTokensPerTask"),
      maxCostUsdPerTask: requireNumber(budget.maxCostUsdPerTask, "budget.maxCostUsdPerTask"),
      maxFixReviewCycles: requireNumber(budget.maxFixReviewCycles, "budget.maxFixReviewCycles"),
      maxPlanningQuestionRounds: requireNumber(
        budget.maxPlanningQuestionRounds,
        "budget.maxPlanningQuestionRounds",
      ),
      maxCoderTurns: requireNumber(budget.maxCoderTurns, "budget.maxCoderTurns"),
    },
  };
}

export function loadProjectConfig(filePath: string): ProjectConfig {
  return parseProjectConfig(readFileSync(filePath, "utf-8"));
}
