// Claude Code worker adapter. Runs the logged-in `claude` CLI (Claude subscription) as a
// write-capable worker in the isolated worktree — an alternative to OpenCode when its
// credits are unavailable.
//
// SECURITY NOTE: unlike the OpenCode adapter, this runs with the caller's real environment
// (the Claude subscription auth lives in the CLI's own store, not an env var we can copy),
// so it is NOT env-isolated. Confinement here is: cwd = the detached worktree, no --add-dir,
// Bash/WebFetch denied, and — as always — the post-run policy gate + clean verifier are the
// acceptance authority. Full OS isolation is the M3 container mode. (PRD P-05/P-09.)
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkerRuntime, RunInput, RawWorkerResult } from "./runtime.ts";
import type { Contract } from "./contract.ts";
import { getProfile, resolveModel, claudeWorkerBin } from "./profiles.ts";
import { matchesAny } from "./policy.ts";
import { runProcessGroup } from "./proc.ts";

// Claude Code writes its own project-memory files (CLAUDE.md, .claude/) into the working
// directory. That is CLI metadata, not task output, so strip it before the policy gate
// sees it — unless the task scope explicitly allows those paths.
function stripClaudeMetadata(worktreeDir: string, contract: Contract): void {
  for (const meta of ["CLAUDE.md", ".claude"]) {
    if (matchesAny(meta, contract.scope.allow)) continue;
    const p = join(worktreeDir, meta);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

function compileTask(contract: Contract): string {
  return [
    `Implement this bounded task by editing files in the current directory only.`,
    ``,
    `Objective: ${contract.objective}`,
    contract.non_goals.length ? `Non-goals:\n${contract.non_goals.map((g) => `- ${g}`).join("\n")}` : ``,
    `Allowed paths (create/edit ONLY files matching these): ${contract.scope.allow.join(", ")}`,
    `Create or edit ONLY files whose paths match the allowed paths. Do NOT create README, CLAUDE.md,`,
    `notes, documentation, config, or any other file outside those paths. Do not run git commit/push or access the network.`,
    contract.acceptance.length
      ? `These commands will be checked independently — make them pass:\n${contract.acceptance.map((a) => `- ${a.id}: ${a.argv.join(" ")}`).join("\n")}`
      : ``,
    ``,
    `Make the edits directly and stop. Do not ask questions.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]!.slice(0, 500) : "claude worker completed";
}

export const claudeWorkerRuntime: WorkerRuntime = {
  id: "claude",
  async run({ worktreeDir, contract, signal }: RunInput): Promise<RawWorkerResult> {
    const profile = getProfile(contract.worker.profile);
    if (!profile) return { ok: false, summary: "", log: `unknown profile ${contract.worker.profile}` };

    const model = resolveModel(profile); // alias, e.g. "sonnet"
    const wallMs = Number(process.env.PATCHBAY_WALL_MS) || profile.limits.maxWallSeconds * 1000;
    const args = [
      "-p",
      compileTask(contract),
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions", // headless: never prompt (would hang); Bash/WebFetch still hard-denied below
      "--disallowedTools",
      "Bash",
      "WebFetch",
    ];

    // Real env so the CLI finds the Claude subscription login; cwd confines edits to the worktree.
    const outcome = await runProcessGroup(claudeWorkerBin(), args, {
      env: process.env,
      cwd: worktreeDir,
      timeoutMs: wallMs,
      maxBytes: profile.limits.maxOutputBytes,
      signal,
    });

    stripClaudeMetadata(worktreeDir, contract);

    const log = `# claude ${model}\nexit=${outcome.code} signal=${outcome.signal} timedOut=${outcome.timedOut} cancelled=${outcome.cancelled}\n\n[stdout]\n${outcome.stdout}\n\n[stderr]\n${outcome.stderr}`;
    if (outcome.cancelled) return { ok: false, summary: "worker cancelled", log };
    if (outcome.timedOut) return { ok: false, summary: "worker timed out", log };
    if (outcome.code !== 0) return { ok: false, summary: `claude exited ${outcome.code}`, log };
    return { ok: true, summary: lastNonEmptyLine(outcome.stdout), log };
  },
};
