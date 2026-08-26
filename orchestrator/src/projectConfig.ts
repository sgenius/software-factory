import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface ProjectConfig {
  name: string;
  budget: {
    maxTokensPerTask: number;
    maxCostUsdPerTask: number;
    maxFixReviewCycles: number;
    maxPlanningQuestionRounds: number;
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

/** Extracts and validates only the fields this codebase currently reads (budget.*) — pure, no file I/O. */
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

  return {
    name,
    budget: {
      maxTokensPerTask: requireNumber(budget.maxTokensPerTask, "budget.maxTokensPerTask"),
      maxCostUsdPerTask: requireNumber(budget.maxCostUsdPerTask, "budget.maxCostUsdPerTask"),
      maxFixReviewCycles: requireNumber(budget.maxFixReviewCycles, "budget.maxFixReviewCycles"),
      maxPlanningQuestionRounds: requireNumber(
        budget.maxPlanningQuestionRounds,
        "budget.maxPlanningQuestionRounds",
      ),
    },
  };
}

export function loadProjectConfig(filePath: string): ProjectConfig {
  return parseProjectConfig(readFileSync(filePath, "utf-8"));
}
