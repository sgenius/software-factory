import { readFileSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { REPO_ROOT } from "../repoRoot.js";
import type { Plan } from "../types.js";

const CODER_SYSTEM_PROMPT_PATH = path.join(REPO_ROOT, "agents/coder/system-prompt.md");

export function loadCoderSystemPrompt(): string {
  return readFileSync(CODER_SYSTEM_PROMPT_PATH, "utf-8");
}

export interface CoderAgentInput {
  taskId: string;
  plan: Plan;
  repoDir: string;
  rubricText: string;
}

export interface CoderAgentResult {
  summary: string;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface CoderAgentClient {
  runCoding(input: CoderAgentInput): Promise<CoderAgentResult>;
}

export class CoderAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoderAgentError";
  }
}

function buildCoderPrompt(input: CoderAgentInput): string {
  return [
    `Task ID: ${input.taskId}`,
    `Plan:\n${JSON.stringify(input.plan, null, 2)}`,
    `Legibility rubric:\n${input.rubricText}`,
  ].join("\n\n");
}

// Minimal local shape for the terminal SDK "result" message — narrower
// than the SDK's own type so this file only depends on the handful of
// fields it actually reads.
interface CoderSessionResult {
  isError: boolean;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function toSessionResult(message: unknown): CoderSessionResult {
  const raw = message as {
    is_error?: unknown;
    total_cost_usd?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  return {
    isError: raw.is_error === true,
    totalCostUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : 0,
    inputTokens: typeof raw.usage?.input_tokens === "number" ? raw.usage.input_tokens : 0,
    outputTokens: typeof raw.usage?.output_tokens === "number" ? raw.usage.output_tokens : 0,
  };
}

/**
 * Coder needs to read/edit files and search a directory tree — the shape
 * of task the Claude Agent SDK is built for (unlike Planner, which is a
 * single structured-output call on the plain Anthropic SDK).
 *
 * Locked down per code.claude.com/docs/en/agent-sdk/permissions: dontAsk
 * + an explicit allowedTools list denies anything unlisted outright, and
 * Read(/**)/Edit(/**) — single leading slash, anchored at `cwd` — confine
 * file access to repoDir rather than approving those tools everywhere on
 * disk (a bare "Edit" entry would). Bash is never in the list. Glob/Grep
 * have no equivalent per-path scoping in the SDK, so they remain a small,
 * read-only residual gap outside repoDir.
 */
export class ClaudeCoderAgentClient implements CoderAgentClient {
  constructor(
    private readonly maxTurns: number,
    private readonly systemPrompt: string = loadCoderSystemPrompt(),
  ) {}

  async runCoding(input: CoderAgentInput): Promise<CoderAgentResult> {
    let summary = "";
    let result: CoderSessionResult | undefined;

    for await (const message of query({
      prompt: buildCoderPrompt(input),
      options: {
        cwd: input.repoDir,
        systemPrompt: this.systemPrompt,
        model: "claude-opus-5",
        maxTurns: this.maxTurns,
        permissionMode: "dontAsk",
        allowedTools: ["Read(/**)", "Edit(/**)", "Glob", "Grep"],
      },
    })) {
      if (message.type === "assistant") {
        summary = extractAssistantText(message) ?? summary;
      }
      if (message.type === "result") {
        result = toSessionResult(message);
      }
    }

    if (!result || result.isError) {
      throw new CoderAgentError(
        `Coder session for task ${input.taskId} did not complete successfully: ${result ? JSON.stringify(result) : "no result message received"}`,
      );
    }

    return {
      summary,
      totalCostUsd: result.totalCostUsd,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  }
}

function extractAssistantText(message: unknown): string | undefined {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
  );
  return textBlock?.text;
}
