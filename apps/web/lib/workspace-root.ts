import path from "node:path";
import { existsSync } from "node:fs";

/** Root containing the shop database, original files and server-side tools. */
export function workspaceRoot(): string {
  if (process.env.LMM_WORKSPACE_ROOT) return path.resolve(process.env.LMM_WORKSPACE_ROOT);
  const cwd = process.cwd();
  return existsSync(path.join(cwd, "pnpm-workspace.yaml")) ? cwd : path.resolve(cwd, "../..");
}
