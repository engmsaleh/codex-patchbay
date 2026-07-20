// Job pipeline + apply guard (PRD 16, 23.6, 24). Orchestrates one delegated task from
// contract to a verified, ready-to-apply candidate — never applying without approval.
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ValidatedContract } from "./contract.ts";
import { hashJson, sha256 } from "./hash.ts";
import { artifactsDir, worktreesDir } from "./paths.ts";
import {
  isGitRepo,
  isClean,
  resolveCommit,
  headCommit,
  repoIdentity,
  addWorktree,
  removeWorktree,
  extractCandidate,
  applyPatch,
  git,
} from "./git.ts";
import { checkPolicy, type ChangedFile, type PolicyResult } from "./policy.ts";
import { verify, type VerificationReceipt } from "./verifier.ts";
import { getRuntime } from "./runtime.ts";
import {
  newJobId,
  saveJob,
  getJob,
  transition,
  type JobRecord,
  type JobState,
} from "./store.ts";

export class PipelineError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

// ---- artifacts -----------------------------------------------------------

function jobArtifactDir(jobId: string): string {
  const d = join(artifactsDir(), jobId);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function writeArtifact(jobId: string, name: string, content: string): string {
  writeFileSync(join(jobArtifactDir(jobId), name), content, { mode: 0o600 });
  return sha256(content);
}

function readArtifact(jobId: string, name: string): string {
  return readFileSync(join(jobArtifactDir(jobId), name), "utf8");
}

// ---- outcome -------------------------------------------------------------

export interface JobOutcome {
  job: JobRecord;
  workerSummary: string;
  changes: ChangedFile[];
  policy?: PolicyResult;
  verification?: VerificationReceipt;
  artifacts: Record<string, string>;
}

function terminate(jobId: string, from: JobState, to: JobState, reason: string, phase: string): JobRecord {
  return transition(jobId, from, to, phase, { terminalReason: reason });
}

// ---- run -----------------------------------------------------------------

/** Run a validated contract end to end. Synchronous through the fake runtime (M1). */
export async function runJob(vc: ValidatedContract, ownerSession: string): Promise<JobOutcome> {
  const { canonical: contract, taskHash } = vc;
  const root = contract.repository.root;

  // Preconditions — fail before creating a job so we never persist junk (PRD 23.2).
  if (!isGitRepo(root)) throw new PipelineError(`not a Git work tree: ${root}`, "configuration_error");
  const base = resolveCommit(root, contract.repository.base_commit);
  if (!base) throw new PipelineError(`base commit not found: ${contract.repository.base_commit}`, "configuration_error");
  if (contract.repository.dirty_policy === "reject" && !isClean(root)) {
    throw new PipelineError("active checkout is dirty; commit or stash before delegating", "configuration_error");
  }

  const jobId = newJobId();
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: jobId,
    repoId: repoIdentity(root),
    repoRoot: root,
    ownerSession,
    taskHash,
    baseCommit: base,
    workerProfile: contract.worker.profile,
    risk: contract.metadata.risk,
    state: "CREATED",
    phase: "created",
    isolationMode: "standard",
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);
  writeArtifact(jobId, "contract.json", JSON.stringify(contract, null, 2));

  const artifacts: Record<string, string> = {};
  const worktreeDir = join(worktreesDir(), `job-${jobId}`);

  try {
    transition(jobId, "CREATED", "VALIDATED", "validated");

    const created = addWorktree(root, base, worktreeDir);
    if (!created.ok) {
      terminate(jobId, "VALIDATED", "ENVIRONMENT_FAILURE", `worktree failed: ${created.stderr.trim()}`, "worktree");
      return { job: getJob(jobId)!, workerSummary: "", changes: [], artifacts };
    }
    transition(jobId, "VALIDATED", "WORKTREE_READY", "worktree_ready");

    // Worker.
    transition(jobId, "WORKTREE_READY", "RUNNING_WORKER", "running_worker");
    const runtime = getRuntime(contract.worker.profile);
    const worker = await runtime.run({ worktreeDir, contract }).catch((e) => ({
      ok: false as const,
      summary: e instanceof Error ? e.message : String(e),
      log: e instanceof Error ? (e.stack ?? e.message) : String(e),
    }));
    artifacts["worker-log.txt"] = writeArtifact(jobId, "worker-log.txt", worker.log);
    if (!worker.ok) {
      terminate(jobId, "RUNNING_WORKER", "FAILED_WORKER", worker.summary, "worker_failed");
      return { job: getJob(jobId)!, workerSummary: worker.summary, changes: [], artifacts };
    }

    // Extract candidate.
    transition(jobId, "RUNNING_WORKER", "PATCH_READY", "patch_ready");
    const candidate = extractCandidate(worktreeDir);
    if (candidate.changes.length === 0) {
      terminate(jobId, "PATCH_READY", "FAILED_WORKER", "worker produced no changes", "no_changes");
      return { job: getJob(jobId)!, workerSummary: worker.summary, changes: [], artifacts };
    }
    artifacts["candidate.patch"] = writeArtifact(jobId, "candidate.patch", candidate.patch);

    // Policy gate.
    transition(jobId, "PATCH_READY", "POLICY_CHECK", "policy_check", { patchHash: candidate.patchHash });
    const policy = checkPolicy(contract, candidate.changes, candidate.patch);
    artifacts["policy.json"] = writeArtifact(jobId, "policy.json", JSON.stringify(policy, null, 2));
    if (!policy.ok) {
      terminate(jobId, "POLICY_CHECK", "FAILED_POLICY", `policy violations: ${policy.violations.map((v) => v.code).join(", ")}`, "policy_failed");
      return { job: getJob(jobId)!, workerSummary: worker.summary, changes: candidate.changes, policy, artifacts };
    }

    // Clean verification (independent worktree).
    transition(jobId, "POLICY_CHECK", "VERIFYING", "verifying");
    const verification = verify(root, base, contract, candidate);
    artifacts["verification.json"] = writeArtifact(jobId, "verification.json", JSON.stringify(verification, null, 2));
    if (!verification.ok) {
      terminate(jobId, "VERIFYING", "FAILED_VERIFICATION", verification.reason, "verification_failed");
      return { job: getJob(jobId)!, workerSummary: worker.summary, changes: candidate.changes, policy, verification, artifacts };
    }

    transition(jobId, "VERIFYING", "VERIFIED", "verified");
    transition(jobId, "VERIFIED", "READY_TO_APPLY", "ready_to_apply");

    const receipt = buildReceipt(getJob(jobId)!, contract, candidate.changes, policy, verification, worker.summary);
    artifacts["receipt.json"] = writeArtifact(jobId, "receipt.json", JSON.stringify(receipt, null, 2));

    return { job: getJob(jobId)!, workerSummary: worker.summary, changes: candidate.changes, policy, verification, artifacts };
  } finally {
    removeWorktree(root, worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// ---- receipt -------------------------------------------------------------

export function buildReceipt(
  job: JobRecord,
  contract: ValidatedContract["canonical"],
  changes: ChangedFile[],
  policy: PolicyResult,
  verification: VerificationReceipt,
  workerSummary: string,
): Record<string, unknown> {
  const receipt = {
    schema_version: "1.0",
    job_id: job.id,
    objective: contract.objective,
    task_hash: job.taskHash,
    repository_id: job.repoId,
    base_commit: job.baseCommit,
    worker: { profile: job.workerProfile, summary: workerSummary },
    isolation_mode: job.isolationMode,
    state: job.state,
    changed_files: changes.map((c) => ({ path: c.path, type: c.type, churn: c.churn })),
    patch_hash: job.patchHash,
    policy_ok: policy.ok,
    verification: { ok: verification.ok, reason: verification.reason, checks: verification.checks.map((c) => ({ id: c.id, classification: c.classification, exit: c.exitCode })) },
    application_status: job.state === "APPLIED" ? "applied" : "not_applied",
  };
  return { ...receipt, receipt_hash: hashJson(receipt) };
}

// ---- apply guard (PRD 16.15, 23.6) --------------------------------------

export interface ApplyPlan {
  ready: boolean;
  reason: string;
  jobId: string;
  currentHead: string | null;
  expectedBase: string;
  patchHash?: string;
  changedFiles: string[];
  prepareToken?: string;
}

export function prepareApply(jobId: string, expectedPatchHash: string): ApplyPlan {
  const job = getJob(jobId);
  const base = job?.baseCommit ?? "";
  const plan: ApplyPlan = { ready: false, reason: "", jobId, currentHead: null, expectedBase: base, changedFiles: [] };
  if (!job) return { ...plan, reason: "job not found" };
  plan.patchHash = job.patchHash;
  if (job.state !== "READY_TO_APPLY") return { ...plan, reason: `job state is ${job.state}, expected READY_TO_APPLY` };
  if (repoIdentity(job.repoRoot) !== job.repoId) return { ...plan, reason: "repository identity mismatch" };
  const head = headCommit(job.repoRoot);
  plan.currentHead = head;
  if (job.patchHash !== expectedPatchHash) return { ...plan, reason: "patch hash mismatch" };
  if (head !== job.baseCommit) return { ...plan, reason: "stale base: HEAD moved since verification; re-integration required" };
  if (!isClean(job.repoRoot)) return { ...plan, reason: "active checkout is dirty" };

  const patch = readArtifact(jobId, "candidate.patch");
  if (sha256(patch) !== job.patchHash) return { ...plan, reason: "stored patch hash mismatch (tampered artifact)" };
  const check = git(["-C", job.repoRoot, "apply", "--check", "--whitespace=nowarn", "-"], patch);
  if (!check.ok) return { ...plan, reason: `patch will not apply cleanly: ${check.stderr.trim()}` };

  const token = randomBytes(16).toString("hex");
  saveJob({ ...job, prepareToken: token });
  return {
    ready: true,
    reason: "ready",
    jobId,
    currentHead: head,
    expectedBase: job.baseCommit,
    patchHash: job.patchHash,
    changedFiles: receiptChangedFiles(jobId),
    prepareToken: token,
  };
}

/** Changed-file paths recorded in the job receipt (for the apply plan). */
function receiptChangedFiles(jobId: string): string[] {
  try {
    const r = JSON.parse(readArtifact(jobId, "receipt.json")) as { changed_files?: { path: string }[] };
    return (r.changed_files ?? []).map((c) => c.path);
  } catch {
    return [];
  }
}

export interface ApplyArgs {
  jobId: string;
  expectedTaskHash: string;
  expectedPatchHash: string;
  expectedBase: string;
  prepareToken: string;
}

export interface ApplyResult {
  ok: boolean;
  reason: string;
  appliedFiles: number;
}

export function applyCandidate(args: ApplyArgs): ApplyResult {
  const job = getJob(args.jobId);
  if (!job) return { ok: false, reason: "job not found", appliedFiles: 0 };
  if (job.state !== "READY_TO_APPLY") return { ok: false, reason: `job state is ${job.state}`, appliedFiles: 0 };
  if (!job.prepareToken || job.prepareToken !== args.prepareToken) return { ok: false, reason: "invalid or missing prepare token", appliedFiles: 0 };
  if (job.taskHash !== args.expectedTaskHash) return { ok: false, reason: "task hash mismatch", appliedFiles: 0 };
  if (job.patchHash !== args.expectedPatchHash) return { ok: false, reason: "patch hash mismatch", appliedFiles: 0 };
  if (job.baseCommit !== args.expectedBase) return { ok: false, reason: "base commit mismatch", appliedFiles: 0 };
  if (repoIdentity(job.repoRoot) !== job.repoId) return { ok: false, reason: "repository identity mismatch", appliedFiles: 0 };
  if (headCommit(job.repoRoot) !== job.baseCommit) return { ok: false, reason: "stale base: HEAD moved", appliedFiles: 0 };
  if (!isClean(job.repoRoot)) return { ok: false, reason: "active checkout is dirty", appliedFiles: 0 };

  const patch = readArtifact(args.jobId, "candidate.patch");
  if (sha256(patch) !== job.patchHash) return { ok: false, reason: "stored patch hash mismatch", appliedFiles: 0 };

  const appliedFiles = receiptChangedFiles(args.jobId).length;
  const applied = applyPatch(job.repoRoot, patch); // working tree only; does not stage or commit (PRD 23.6)
  if (!applied.ok) return { ok: false, reason: `apply failed: ${applied.stderr.trim()}`, appliedFiles: 0 };

  // Record the disposition. Post-apply tree re-hash on the ACTIVE checkout is skipped so
  // we never mutate the user's index; integrity is already proven by the isolated verifier
  // and the stored-patch hash gate above (PRD 23.6).
  transition(args.jobId, "READY_TO_APPLY", "APPLIED", "applied", { prepareToken: undefined });
  const receipt = JSON.parse(readArtifact(args.jobId, "receipt.json")) as Record<string, unknown>;
  receipt.state = "APPLIED";
  receipt.application_status = "applied";
  delete receipt.receipt_hash;
  receipt.receipt_hash = hashJson(receipt);
  writeArtifact(args.jobId, "receipt.json", JSON.stringify(receipt, null, 2));
  return { ok: true, reason: "applied", appliedFiles };
}

export function _testReadArtifact(jobId: string, name: string): string {
  return readArtifact(jobId, name);
}
