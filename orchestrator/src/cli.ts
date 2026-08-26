import Anthropic from "@anthropic-ai/sdk";
import { loadProjectConfig } from "./projectConfig.js";
import { ClaudePlannerAgentClient } from "./agents/plannerAgent.js";
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
  const interactionChannel = new CliHumanInteractionChannel();

  const taskState = await runTask({
    taskId: args.taskId,
    requirement: args.requirement,
    projectConfig,
    plannerClient,
    interactionChannel,
  });

  console.log(`\nPlanning finished for task "${args.taskId}".`);
  console.log(`Plan written to: ${taskWorkspacePath(args.taskId)}/plan.json`);
  console.log(`Task state: stage="${taskState.stage}", status="${taskState.status}".`);
  if (taskState.stage === "coding") {
    console.log(
      'The task now sits in the "coding" stage awaiting a Coder implementation, which isn\'t wired up yet.',
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
