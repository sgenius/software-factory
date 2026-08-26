import Anthropic from "@anthropic-ai/sdk";
import { assertValid, validateTestResult } from "../schemaValidation.js";
import { loadTesterSystemPrompt } from "./testAuthorAgent.js";
import type { Plan, TestResult } from "../types.js";
import type { TestCommandResult } from "../testExecution.js";

export interface TestResultAgentInput {
  taskId: string;
  plan: Plan;
  testCommand: string;
  commandResult: TestCommandResult;
}

export interface TestResultAgentClient {
  runInterpretation(input: TestResultAgentInput): Promise<TestResult>;
}

export class TestResultParseError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
  ) {
    super(message);
    this.name = "TestResultParseError";
  }
}

/**
 * Turn 2 of Tester: given the plan's acceptance criteria and the *real*
 * output from actually running the project's test command (testExecution.ts
 * — never this agent), reports structured pass/fail. Single structured-
 * output call, plain Anthropic SDK, same shape as Reviewer/Planner.
 */
export class ClaudeTestResultAgentClient implements TestResultAgentClient {
  constructor(
    private readonly anthropic: Anthropic,
    private readonly systemPrompt: string = loadTesterSystemPrompt(),
  ) {}

  async runInterpretation(input: TestResultAgentInput): Promise<TestResult> {
    const response = await this.anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: this.systemPrompt,
      messages: [{ role: "user", content: buildReportPrompt(input) }],
    });

    const testResult = parseJson(extractText(response));
    assertValid(validateTestResult, "test-result", testResult);
    return testResult as TestResult;
  }
}

function buildReportPrompt(input: TestResultAgentInput): string {
  return [
    "Turn 2: Report.",
    `Task ID: ${input.taskId}`,
    `Acceptance criteria:\n${JSON.stringify(input.plan.acceptanceCriteria, null, 2)}`,
    `Test command run: ${input.testCommand}`,
    `Exit code: ${input.commandResult.exitCode}`,
    `stdout:\n${input.commandResult.stdout}`,
    `stderr:\n${input.commandResult.stderr}`,
  ].join("\n\n");
}

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new TestResultParseError("Tester Report response had no text block", JSON.stringify(response.content));
  }
  return textBlock.text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TestResultParseError(`Tester Report output was not valid JSON: ${(error as Error).message}`, text);
  }
}
