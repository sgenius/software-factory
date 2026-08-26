import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { assertValid, validateReviewResult } from "../schemaValidation.js";
import { REPO_ROOT } from "../repoRoot.js";
import type { Plan, ReviewResult } from "../types.js";

const REVIEWER_SYSTEM_PROMPT_PATH = path.join(REPO_ROOT, "agents/reviewer/system-prompt.md");

export function loadReviewerSystemPrompt(): string {
  return readFileSync(REVIEWER_SYSTEM_PROMPT_PATH, "utf-8");
}

export interface ReviewerAgentInput {
  taskId: string;
  plan: Plan;
  diff: string;
  rubricText: string;
}

export interface ReviewerAgentClient {
  runReview(input: ReviewerAgentInput): Promise<ReviewResult>;
}

export class ReviewResultParseError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
  ) {
    super(message);
    this.name = "ReviewResultParseError";
  }
}

/**
 * Reviewer's input (diff + rubric + plan) is entirely inlinable — no file
 * access or execution needed. Same shape as Planner: a single structured-
 * output call on the plain Anthropic SDK, not the Claude Agent SDK.
 */
export class ClaudeReviewerAgentClient implements ReviewerAgentClient {
  constructor(
    private readonly anthropic: Anthropic,
    private readonly systemPrompt: string = loadReviewerSystemPrompt(),
  ) {}

  async runReview(input: ReviewerAgentInput): Promise<ReviewResult> {
    const response = await this.anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: this.systemPrompt,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    const reviewResult = parseJson(extractText(response));
    assertValid(validateReviewResult, "review-result", reviewResult);
    return reviewResult as ReviewResult;
  }
}

function buildUserMessage(input: ReviewerAgentInput): string {
  return [
    `Task ID: ${input.taskId}`,
    `Plan:\n${JSON.stringify(input.plan, null, 2)}`,
    `Diff:\n${input.diff}`,
    `Legibility rubric:\n${input.rubricText}`,
  ].join("\n\n");
}

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new ReviewResultParseError("Reviewer response had no text block", JSON.stringify(response.content));
  }
  return textBlock.text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReviewResultParseError(`Reviewer output was not valid JSON: ${(error as Error).message}`, text);
  }
}
