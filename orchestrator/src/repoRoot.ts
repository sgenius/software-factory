import { fileURLToPath } from "node:url";
import path from "node:path";

// orchestrator/src/repoRoot.ts -> ../.. (repo root, one level up from
// orchestrator/). Same relative depth from orchestrator/dist after build
// (tsconfig.build.json's rootDir is orchestrator/src).
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
