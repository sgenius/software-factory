import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { assertValid, validatePlannerTurn } from "../schemaValidation.js";
import { REPO_ROOT } from "../repoRoot.js";
import type { PlannerAnswer, PlannerTurn } from "../types.js";

const PLANNER_SYSTEM_PROMPT_PATH = path.join(REPO_ROOT, "agents/planner/system-prompt.md");

export function loadPlannerSystemPrompt(): string {
  return readFileSync(PLANNER_SYSTEM_PROMPT_PATH, "utf-8");
}

export interface PlannerAgentInput {
  taskId: string;
  requirement: string;
  /** Accumulated across every round of this task's planning phase so far. */
  priorAnswers: PlannerAnswer[];
}

export interface PlannerAgentClient {
  runTurn(input: PlannerAgentInput): Promise<PlannerTurn>;
}

export class PlannerTurnParseError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
  ) {
    super(message);
    this.name = "PlannerTurnParseError";
  }
}

/** Planner is a single structured-output call — the plain Anthropic SDK, not the Claude Agent SDK (no file/bash access needed). */
export class ClaudePlannerAgentClient implements PlannerAgentClient {
  constructor(
    private readonly anthropic: Anthropic,
    private readonly systemPrompt: string = loadPlannerSystemPrompt(),
  ) {}

  async runTurn(input: PlannerAgentInput): Promise<PlannerTurn> {
    const response = await this.anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: this.systemPrompt,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    const turn = parseJson(extractText(response));
    assertValid(validatePlannerTurn, "planner-turn", turn);
    return turn as PlannerTurn;
  }
}

function buildUserMessage(input: PlannerAgentInput): string {
  const sections = [`Task ID: ${input.taskId}`, `Requirement:\n${input.requirement}`];

  if (input.priorAnswers.length > 0) {
    const answers = input.priorAnswers
      .map((answer) => {
        const notes = answer.notes ? ` (${answer.notes})` : "";
        return `- ${answer.questionId}: ${answer.selectedLabel}${notes}`;
      })
      .join("\n");
    sections.push(`Answers to your previous questions:\n${answers}`);
  }

  return sections.join("\n\n");
}

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new PlannerTurnParseError(
      "Planner response had no text block",
      JSON.stringify(response.content),
    );
  }
  return textBlock.text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PlannerTurnParseError(
      `Planner output was not valid JSON: ${(error as Error).message}`,
      text,
    );
  }
}
