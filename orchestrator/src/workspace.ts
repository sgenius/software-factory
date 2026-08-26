import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// orchestrator/src/workspace.ts -> ../../workspace (repo root, one level
// up from orchestrator/). Same relative depth from orchestrator/dist after
// build (tsconfig.build.json's rootDir is orchestrator/src).
export const DEFAULT_WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../workspace",
);

export function taskWorkspacePath(taskId: string, root: string = DEFAULT_WORKSPACE_ROOT): string {
  return path.join(root, taskId);
}

export async function ensureTaskWorkspace(
  taskId: string,
  root: string = DEFAULT_WORKSPACE_ROOT,
): Promise<string> {
  const dir = taskWorkspacePath(taskId, root);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeTaskArtifact(
  taskId: string,
  fileName: string,
  data: unknown,
  root: string = DEFAULT_WORKSPACE_ROOT,
): Promise<void> {
  const filePath = path.join(taskWorkspacePath(taskId, root), fileName);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
