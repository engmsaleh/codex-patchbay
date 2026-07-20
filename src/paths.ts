// Local state locations. Everything lives outside the repository so a worker in a
// worktree cannot read Patchbay's own state (PRD 22.2). Override with PATCHBAY_DATA_DIR.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function dataDir(): string {
  const d = process.env.PATCHBAY_DATA_DIR ?? join(homedir(), ".patchbay", "data");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function sub(name: string): string {
  const d = join(dataDir(), name);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export const worktreesDir = () => sub("worktrees");
export const jobsDir = () => sub("jobs");
export const artifactsDir = () => sub("artifacts");
