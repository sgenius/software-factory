import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { taskWorkspacePath } from "./workspace.js";
import type { FindingSeverity, Plan, ReviewResult, TaskState, TestResult } from "./types.js";

/**
 * Decoupled interaction surface for the review gate — structurally
 * different from HumanInteractionChannel's multi-question Q&A: present
 * the finished work, get back one of three decisions.
 */
export interface HumanGateRequest {
  taskId: string;
  plan: Plan;
  diff: string;
  testResult: TestResult;
  /** Absent if the task escalated here via repeated test failures without ever reaching review. */
  reviewResult?: ReviewResult;
  taskState: TaskState;
}

export type HumanGateDecision =
  | { type: "approved" }
  | { type: "rejected"; reason?: string }
  | { type: "requested_changes"; feedback: string };

export interface HumanGateChannel {
  requestDecision(request: HumanGateRequest): Promise<HumanGateDecision>;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { blocking: 0, nit: 1, question: 2 };

/**
 * Prints a summary of the task's outcome and reads an approve/reject/
 * request-changes decision from stdin. The default channel for a
 * standalone-Node run.
 */
export class CliHumanGateChannel implements HumanGateChannel {
  async requestDecision(request: HumanGateRequest): Promise<HumanGateDecision> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      this.printSummary(request);
      return await this.readDecision(rl);
    } finally {
      rl.close();
    }
  }

  private printSummary(request: HumanGateRequest): void {
    stdout.write(`\n=== Human gate: task "${request.taskId}" ===\n`);
    stdout.write(
      request.taskState.escalated
        ? `Reached here because the fix/review cycle cap (${request.taskState.maxFixReviewCycles}) was reached.\n`
        : "Review came back clean.\n",
    );

    const passed = request.testResult.results.filter((result) => result.passed).length;
    stdout.write(`\nTests: ${passed}/${request.testResult.results.length} acceptance criteria passing.\n`);
    for (const result of request.testResult.results.filter((r) => !r.passed)) {
      stdout.write(`  - ${result.criterionId}: ${result.reason ?? "no reason given"}\n`);
    }

    if (request.reviewResult) {
      const findings = [...request.reviewResult.findings].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
      );
      stdout.write(`\nReview findings (confidence ${request.reviewResult.confidence}):\n`);
      if (findings.length === 0) {
        stdout.write("  (none)\n");
      }
      for (const finding of findings) {
        const rubricRef = finding.rubricRef ? ` [${finding.rubricRef}]` : "";
        stdout.write(`  - [${finding.severity}] ${finding.file}:${finding.line} — ${finding.summary}${rubricRef}\n`);
      }
    } else {
      stdout.write("\nReview: never reached (escalated on repeated test failures).\n");
    }

    stdout.write(`\nFull diff: ${taskWorkspacePath(request.taskId)}/diff.patch\n`);
  }

  private async readDecision(rl: ReturnType<typeof createInterface>): Promise<HumanGateDecision> {
    stdout.write("\n  1. Approve\n  2. Reject\n  3. Request changes\n");
    const choice = await this.readValidChoice(rl);

    if (choice === 1) {
      return { type: "approved" };
    }
    if (choice === 2) {
      const reason = await rl.question("Reason (optional, press Enter to skip): ");
      return { type: "rejected", ...(reason.trim() ? { reason: reason.trim() } : {}) };
    }
    const feedback = await this.readRequiredFeedback(rl);
    return { type: "requested_changes", feedback };
  }

  private async readValidChoice(rl: ReturnType<typeof createInterface>): Promise<1 | 2 | 3> {
    while (true) {
      const raw = await rl.question("Choose 1-3: ");
      const choice = Number.parseInt(raw, 10);
      if (choice === 1 || choice === 2 || choice === 3) {
        return choice;
      }
      stdout.write("Please enter 1, 2, or 3.\n");
    }
  }

  private async readRequiredFeedback(rl: ReturnType<typeof createInterface>): Promise<string> {
    while (true) {
      const feedback = await rl.question("What needs to change? ");
      if (feedback.trim()) {
        return feedback.trim();
      }
      stdout.write("Feedback is required so Coder has something to act on.\n");
    }
  }
}
