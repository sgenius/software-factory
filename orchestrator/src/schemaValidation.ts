import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

// ajv-formats' CJS/ESM dual-export shape doesn't type correctly through a
// plain `import addFormats from "ajv-formats"` under NodeNext resolution
// (same known issue as ajv's own default export) — require() it directly.
const addFormats: typeof import("ajv-formats").default =
  createRequire(import.meta.url)("ajv-formats");

// orchestrator/src/schemaValidation.ts -> ../../schemas (repo root, one
// level up from orchestrator/). Same relative depth from orchestrator/dist
// after build, so this holds for both ts-node/tsx and compiled output.
const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../schemas",
);

// Our schemas declare "$schema": draft/2020-12, which the plain Ajv export
// (draft-07 meta-schema) doesn't know how to validate against.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

function loadSchema(fileName: string): object {
  const raw = readFileSync(path.join(SCHEMAS_DIR, fileName), "utf-8");
  return JSON.parse(raw);
}

function compile(fileName: string): ValidateFunction {
  return ajv.compile(loadSchema(fileName));
}

// plan.schema.json must compile first: planner-turn.schema.json $refs it by
// $id, and ajv can only resolve a $ref to a schema already added.
export const validatePlan = compile("plan.schema.json");
export const validatePlannerTurn = compile("planner-turn.schema.json");
export const validateReviewFinding = compile("review-finding.schema.json");
export const validateTaskState = compile("task-state.schema.json");

export class SchemaValidationError extends Error {
  constructor(
    schemaName: string,
    public readonly errors: ValidateFunction["errors"],
  ) {
    super(
      `${schemaName} validation failed: ${JSON.stringify(errors, null, 2)}`,
    );
    this.name = "SchemaValidationError";
  }
}

export function assertValid(
  validate: ValidateFunction,
  schemaName: string,
  payload: unknown,
): void {
  if (!validate(payload)) {
    throw new SchemaValidationError(schemaName, validate.errors);
  }
}
