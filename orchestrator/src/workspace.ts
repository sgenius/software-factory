import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "./repoRoot.js";

export const DEFAULT_WORKSPACE_ROOT = path.join(REPO_ROOT, "workspace");

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
  await writeTaskTextFile(taskId, fileName, JSON.stringify(data, null, 2), root);
}

export async function writeTaskTextFile(
  taskId: string,
  fileName: string,
  text: string,
  root: string = DEFAULT_WORKSPACE_ROOT,
): Promise<void> {
  const filePath = path.join(taskWorkspacePath(taskId, root), fileName);
  await writeFile(filePath, text, "utf-8");
}
