import Anthropic from "@anthropic-ai/sdk";
import { loadProjectConfig } from "./projectConfig.js";
import { ClaudePlannerAgentClient } from "./agents/plannerAgent.js";
import { ClaudeCoderAgentClient } from "./agents/coderAgent.js";
import { ClaudeTestAuthorAgentClient } from "./agents/testAuthorAgent.js";
import { ClaudeTestResultAgentClient } from "./agents/testResultAgent.js";
import { ClaudeReviewerAgentClient } from "./agents/reviewerAgent.js";
import { CliHumanInteractionChannel } from "./humanInteraction.js";
import { runTask } from "./taskRunner.js";
import { taskWorkspacePath } from "./workspace.js";

interface CliArgs {
  project: string;
  taskId: string;
  requirement: string;
}

function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        `Unexpected argument "${flag}". Usage: --project <path-to-yaml> --task-id <id> --requirement <text>`,
      );
    }
    flags[flag.slice(2)] = value;
  }

  const { project, "task-id": taskId, requirement } = flags;
  if (!project || !taskId || !requirement) {
    throw new Error("Required flags: --project <path-to-yaml> --task-id <id> --requirement <text>");
  }
  return { project, taskId, requirement };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectConfig = loadProjectConfig(args.project);
  const anthropic = new Anthropic();

  const plannerClient = new ClaudePlannerAgentClient(anthropic);
  const coderClient = new ClaudeCoderAgentClient(projectConfig.budget.maxCoderTurns);
  const testAuthorClient = new ClaudeTestAuthorAgentClient(projectConfig.budget.maxTesterTurns);
  const testResultClient = new ClaudeTestResultAgentClient(anthropic);
  const reviewerClient = new ClaudeReviewerAgentClient(anthropic);
  const interactionChannel = new CliHumanInteractionChannel();

  const taskState = await runTask({
    taskId: args.taskId,
    requirement: args.requirement,
    projectConfig,
    plannerClient,
    coderClient,
    testAuthorClient,
    testResultClient,
    reviewerClient,
    interactionChannel,
  });

  const taskDir = taskWorkspacePath(args.taskId);
  console.log(`\nRun finished for task "${args.taskId}".`);
  console.log(`Plan: ${taskDir}/plan.json`);
  console.log(`Diff: ${taskDir}/diff.patch`);
  console.log(`Test results: ${taskDir}/test-results.json`);
  console.log(`Task state: stage="${taskState.stage}", status="${taskState.status}".`);

  if (taskState.stage === "coding") {
    console.log(
      "Tests or review sent this task back to \"coding\" for another fix cycle — automatic fix-retry isn't wired up yet.",
    );
  } else if (taskState.stage === "human_gate") {
    const reason = taskState.escalated
      ? "the fix/review cycle cap was reached"
      : "review came back clean";
    console.log(`Task is at the human gate (${reason}) — human-gate wiring isn't built yet.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
