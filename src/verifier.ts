// Clean verifier (PRD 16.11, 24). Applies the candidate patch to a FRESH worktree at
// the exact base and runs the contract's acceptance commands. A worker's own test run is
// never trusted — this is the only acceptance evidence (P-02).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Contract } from "./contract.ts";
import type { Candidate } from "./git.ts";
import { addWorktree, removeWorktree, applyPatch, appliedPatchHash } from "./git.ts";
import { worktreesDir } from "./paths.ts";

export type CheckClassification =
  | "passed"
  | "test_failed"
  | "lint_failed"
  | "type_failed"
  | "build_failed"
  | "timeout"
  | "command_not_found"
  | "dependency_environment_failure"
  | "sandbox_failure"
  | "cancelled"
  | "policy_rejected"
  | "failed";

export interface CheckResult {
  id: string;
  argv: string[];
  required: boolean;
  classification: CheckClassification;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface VerificationReceipt {
  ok: boolean;
  patchApplied: boolean;
  hashMatched: boolean;
  baseCommit: string;
  patchHash: string;
  checks: CheckResult[];
  reason: string;
}

const TAIL = 4000; // bounded evidence per stream (PRD 24.2)
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);
const stripQuotes = (arg: string) => arg.replace(/^["']|["']$/g, "");

function classifyFromCommand(
  argv: string[],
  id: string,
  signal: NodeJS.Signals | null,
  errCode?: string,
  status?: number | null,
): CheckClassification {
  if (signal) return "timeout";
  if (errCode === "ENOENT") return "command_not_found";
  if (errCode === "EACCES") return "sandbox_failure";
  if (status === null) return "sandbox_failure";
  if (status === 0) return "passed";

  const normalizedId = id.toLowerCase();
  const executable = stripQuotes(argv[0] ?? "").toLowerCase();
  const marker = `${normalizedId} ${executable} ${argv.slice(1).join(" ")}`.toLowerCase();

  if (["lint", "eslint", "prettier", "ruff", "pylint", "stylecheck"].some((token) => normalizedId.includes(token))) {
    return "lint_failed";
  }
  if (["typecheck", "type-check", "tsc", "pyright", "mypy", "typetest", "types"].some((token) => normalizedId.includes(token))) {
    return "type_failed";
  }
  if (["build", "compile", "bundle", "rollup", "webpack", "vite build", "esbuild", "rustc"].some((token) => normalizedId.includes(token))) {
    return "build_failed";
  }
  if (["deps", "dependency", "install", "npm", "pnpm", "yarn", "bun", "pip", "cargo", "maven", "gradle"].some((token) => marker.includes(token))) {
    return "dependency_environment_failure";
  }

  return "test_failed";
}

/** Environment for verifier commands: strip provider/model credentials (PRD 16.11). */
function verifierEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(k) || /^(ANTHROPIC|OPENAI|DEEPSEEK|ZAI|GLM)_/i.test(k)) {
      delete env[k];
    }
  }
  return env;
}

function runCommand(cwd: string, id: string, argv: string[], timeoutSec: number): CheckResult {
  const start = Date.now();
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env: verifierEnv(),
    encoding: "utf8",
    shell: false,
    timeout: timeoutSec * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const classification = classifyFromCommand(argv, id, r.signal ?? null, errCode, r.status);

  return {
    id,
    argv,
    required: true,
    classification,
    exitCode: r.status,
    durationMs,
    stdoutTail: tail(r.stdout ?? ""),
    stderrTail: tail(r.stderr ?? ""),
  };
}

/** Verify a candidate patch in isolation. Caller supplies the worker's repo root + full base SHA. */
export function verify(repoRoot: string, base: string, contract: Contract, candidate: Candidate): VerificationReceipt {
  const dir = join(worktreesDir(), `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const checks: CheckResult[] = [];
  try {
    const created = addWorktree(repoRoot, base, dir);
    if (!created.ok) {
      return { ok: false, patchApplied: false, hashMatched: false, baseCommit: base, patchHash: candidate.patchHash, checks, reason: `worktree failed: ${created.stderr.trim()}` };
    }

    const applied = applyPatch(dir, candidate.patch);
    if (!applied.ok) {
      return { ok: false, patchApplied: false, hashMatched: false, baseCommit: base, patchHash: candidate.patchHash, checks, reason: `patch did not apply: ${applied.stderr.trim()}` };
    }

    const hashMatched = appliedPatchHash(dir) === candidate.patchHash;
    if (!hashMatched) {
      return { ok: false, patchApplied: true, hashMatched: false, baseCommit: base, patchHash: candidate.patchHash, checks, reason: "applied result does not match candidate patch hash" };
    }

    for (const a of contract.acceptance) {
      const cwd = a.cwd === "." ? dir : join(dir, a.cwd);
      const res = runCommand(cwd, a.id, a.argv, a.timeout_seconds);
      res.required = a.required;
      checks.push(res);
    }

    const failedRequired = checks.find((c) => c.required && c.classification !== "passed");
    const ok = !failedRequired;
    return {
      ok,
      patchApplied: true,
      hashMatched: true,
      baseCommit: base,
      patchHash: candidate.patchHash,
      checks,
      reason: ok ? "all required checks passed" : `required check ${failedRequired!.id} ${failedRequired!.classification}`,
    };
  } finally {
    removeWorktree(repoRoot, dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
