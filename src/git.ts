// Git isolation and patch handling (PRD 16.7, 16.10, 23). All commands run via argv,
// never a shell. Worktrees are detached at an exact base commit so a worker can never
// touch the user's branch or active checkout.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "./hash.ts";
import type { ChangedFile, ChangeType } from "./policy.ts";

export interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function git(args: string[], input?: string, timeoutMs = 30000): GitResult {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function isGitRepo(root: string): boolean {
  const r = git(["-C", root, "rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

/** Stable repository identity from the Git common dir + toplevel (PRD 23.1). */
export function repoIdentity(root: string): string {
  const common = git(["-C", root, "rev-parse", "--absolute-git-dir"]).stdout.trim();
  const top = git(["-C", root, "rev-parse", "--show-toplevel"]).stdout.trim();
  return sha256(`${common}\n${top}`);
}

/** Resolve a ref to a full commit SHA, or null if it is not a commit. */
export function resolveCommit(root: string, ref: string): string | null {
  const r = git(["-C", root, "rev-parse", "--verify", `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

export function isClean(root: string): boolean {
  const r = git(["-C", root, "status", "--porcelain"]);
  return r.ok && r.stdout.trim() === "";
}

export function headCommit(root: string): string | null {
  return resolveCommit(root, "HEAD");
}

/** Create a detached worktree at `base` under `dir`. Never checks out a branch by name. */
export function addWorktree(root: string, base: string, dir: string): GitResult {
  return git(["-C", root, "worktree", "add", "--detach", dir, base]);
}

export function removeWorktree(root: string, dir: string): GitResult {
  return git(["-C", root, "worktree", "remove", "--force", dir]);
}

export interface Candidate {
  changes: ChangedFile[];
  patch: string;
  patchHash: string;
}

const STATUS_MAP: Record<string, ChangeType> = { A: "added", M: "modified", D: "deleted", T: "modified" };

/**
 * Stage every change (including untracked) in a worktree that is detached at the base,
 * then produce the full inventory and a canonical patch relative to the base.
 * ponytail: `git add -A` skips .gitignored paths; a worker writing to an ignored path
 * won't appear here — acceptable for v0.1 since such files are never applied. Upgrade to
 * `status --ignored` scanning if ignored-path exfiltration becomes a concern.
 */
export function extractCandidate(worktreeDir: string): Candidate {
  git(["-C", worktreeDir, "add", "-A"]);

  const changes: ChangedFile[] = [];

  // Mode + status per file (mode 120000 == symlink).
  const raw = git(["-C", worktreeDir, "diff", "--cached", "--no-renames", "--raw"]).stdout;
  const modeByPath = new Map<string, { type: ChangeType; isSymlink: boolean }>();
  for (const line of raw.split("\n")) {
    if (!line.startsWith(":")) continue;
    const [meta, path] = line.split("\t");
    if (!path) continue;
    const parts = meta!.slice(1).split(" "); // oldmode newmode oldsha newsha status
    const newMode = parts[1] ?? "";
    const statusCode = (parts[4] ?? "M")[0]!;
    modeByPath.set(path, {
      type: STATUS_MAP[statusCode] ?? "modified",
      isSymlink: newMode === "120000",
    });
  }

  // Churn + binary detection.
  const numstat = git(["-C", worktreeDir, "diff", "--cached", "--no-renames", "--numstat"]).stdout;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, path] = line.split("\t");
    if (!path) continue;
    const isBinary = added === "-" && removed === "-";
    const meta = modeByPath.get(path) ?? { type: "modified" as ChangeType, isSymlink: false };
    changes.push({
      path,
      type: meta.type,
      isSymlink: meta.isSymlink,
      isBinary,
      churn: isBinary ? 0 : Number(added || 0) + Number(removed || 0),
    });
  }

  const patch = git(["-C", worktreeDir, "diff", "--cached", "--no-renames", "--binary"]).stdout;
  return { changes, patch, patchHash: sha256(patch) };
}

/** Apply a candidate patch to a worktree (creates/deletes files as needed). */
export function applyPatch(worktreeDir: string, patch: string): GitResult {
  if (patch.trim() === "") return { ok: true, status: 0, stdout: "", stderr: "empty patch" };
  const tmp = mkdtempSync(join(tmpdir(), "patchbay-apply-"));
  const file = join(tmp, "candidate.patch");
  try {
    writeFileSync(file, patch);
    return git(["-C", worktreeDir, "apply", "--whitespace=nowarn", file]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Re-hash the applied result to confirm it matches the candidate patch (PRD 16.11). */
export function appliedPatchHash(worktreeDir: string): string {
  git(["-C", worktreeDir, "add", "-A"]);
  const patch = git(["-C", worktreeDir, "diff", "--cached", "--no-renames", "--binary"]).stdout;
  return sha256(patch);
}
