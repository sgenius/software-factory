import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCodingPhase } from "../src/codingPhase.js";
import { TaskStateMachine } from "../src/stateMachine.js";
import type { CoderAgentClient, CoderAgentInput, CoderAgentResult } from "../src/agents/coderAgent.js";
import type { Plan } from "../src/types.js";

const execFileAsync = promisify(execFile);

const samplePlan: Plan = {
  taskId: "task-1",
  requirement: "add x",
  tasks: [{ id: "t1", description: "do it" }],
  filesToTouch: [{ path: "src/x.ts", reason: "why" }],
  acceptanceCriteria: [{ id: "a1", description: "x returns y" }],
};

class ScriptedCoderClient implements CoderAgentClient {
  public receivedInput: CoderAgentInput | undefined;

  constructor(
    private readonly result: CoderAgentResult,
    private readonly onRun?: (input: CoderAgentInput) => void,
  ) {}

  async runCoding(input: CoderAgentInput): Promise<CoderAgentResult> {
    this.receivedInput = input;
    this.onRun?.(input);
    return this.result;
  }
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("runCodingPhase", () => {
  it("applies CODE_READY and returns the diff produced by the (faked) Coder session", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sf-coding-test-"));
    await execFileAsync("git", ["init", tempDir]);

    const coderClient = new ScriptedCoderClient(
      { summary: "done", totalCostUsd: 0.01, usage: { inputTokens: 100, outputTokens: 50 } },
      () => {
        // Simulate what a real Coder session would have produced by editing repoDir directly.
        writeFileSync(path.join(tempDir!, "src.ts"), "export const x = 1;\n", "utf-8");
      },
    );
    const stateMachine = new TaskStateMachine("task-1", { maxTokens: 1_000_000, maxCostUsd: 100 }, 3);
    stateMachine.apply("s1", { type: "PLAN_READY" });

    const result = await runCodingPhase({
      taskId: "task-1",
      plan: samplePlan,
      repoDir: tempDir,
      rubricText: "keep functions short",
      stateMachine,
      coderClient,
    });

    expect(stateMachine.getState().stage).toBe("testing");
    expect(result.summary).toBe("done");
    expect(result.diff).toContain("src.ts");
    expect(result.diff).toContain("export const x = 1;");
    expect(coderClient.receivedInput).toMatchObject({ taskId: "task-1", plan: samplePlan, repoDir: tempDir });
  });
});
