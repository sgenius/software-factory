import Anthropic from "@anthropic-ai/sdk";
import { loadProjectConfig } from "./projectConfig.js";
import { ClaudePlannerAgentClient } from "./agents/plannerAgent.js";
import { ClaudeCoderAgentClient } from "./agents/coderAgent.js";
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

  const plannerClient = new ClaudePlannerAgentClient(new Anthropic());
  const coderClient = new ClaudeCoderAgentClient(projectConfig.budget.maxCoderTurns);
  const interactionChannel = new CliHumanInteractionChannel();

  const taskState = await runTask({
    taskId: args.taskId,
    requirement: args.requirement,
    projectConfig,
    plannerClient,
    coderClient,
    interactionChannel,
  });

  const taskDir = taskWorkspacePath(args.taskId);
  console.log(`\nCoding finished for task "${args.taskId}".`);
  console.log(`Plan: ${taskDir}/plan.json`);
  console.log(`Diff: ${taskDir}/diff.patch`);
  console.log(`Task state: stage="${taskState.stage}", status="${taskState.status}".`);
  if (taskState.stage === "testing") {
    console.log(
      'The task now sits in the "testing" stage awaiting a Tester implementation, which isn\'t wired up yet.',
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
