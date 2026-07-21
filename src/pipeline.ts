// Job pipeline + apply guard (PRD 16, 23.6, 24). Orchestrates one delegated task from
// contract to a verified, ready-to-apply candidate — never applying without approval.
import { writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type Contract, type ValidatedContract, validateContract } from "./contract.ts";
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
  appliedPatchHash,
  git,
} from "./git.ts";
import { checkPolicy, type ChangedFile, type PolicyResult } from "./policy.ts";
import { verify, type VerificationReceipt } from "./verifier.ts";
import { getRuntime } from "./runtime.ts";
import {
  runReview,
  type FindingDispositionInput,
  type ReviewDisposition,
  type DispositionRecord,
  type StoredReviewArtifact,
  type ReviewMode,
} from "./review.ts";
import {
  newJobId,
  saveJob,
  getJob,
  transition,
  appendEvent,
  jobEventsPath,
  TERMINAL,
  type JobRecord,
  type JobState,
  listJobs,
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
  review?: StoredReviewArtifact;
  policy?: PolicyResult;
  verification?: VerificationReceipt;
  artifacts: Record<string, string>;
}

const ALLOWED_REVIEW_DISPOSITIONS = new Set<ReviewDisposition>([
  "confirmed",
  "rejected_false_positive",
  "duplicate",
  "needs_experiment",
  "needs_human_decision",
  "out_of_scope",
]);

function terminate(jobId: string, from: JobState, to: JobState, reason: string, phase: string): JobRecord {
  return transition(jobId, from, to, phase, { terminalReason: reason });
}


function readJobContract(jobId: string): Contract | null {
  try {
    return JSON.parse(readArtifact(jobId, "contract.json")) as Contract;
  } catch {
    return null;
  }
}

function cleanupWorktreesForJob(jobId: string): void {
  const root = worktreesDir();
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith(`job-${jobId}`) && !entry.startsWith(`stale-${jobId}-`)) continue;
    const p = join(root, entry);
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function recoverInterruptedJobs(): void {
  for (const job of listJobs()) {
    if (TERMINAL.has(job.state) || job.state === "ARCHIVED") continue;
    if (job.state === "READY_TO_APPLY") continue;

    cleanupWorktreesForJob(job.id);
    try {
      if (job.state === "APPLIED" || job.state === "CANCELLED") {
        transition(job.id, job.state, "ARCHIVED", "recovered from interruption");
      } else if (job.state === "RUNNING_WORKER" || job.state === "VERIFYING" || job.state === "PATCH_READY" || job.state === "POLICY_CHECK" || job.state === "REVIEWING" || job.state === "RUNNING_REPAIR") {
        markNeedsCodex(job.id, job.state, "recovered from restart (worker/verification/review not durable)");
      } else if (job.state === "CANCEL_REQUESTED") {
        transition(job.id, "CANCEL_REQUESTED", "CANCELLED", "recovered_from_restart", { terminalReason: "recovered from restart while cancel was requested" });
      } else if (job.state === "STALE") {
        markNeedsCodex(job.id, "STALE", "recovered from restart during stale reintegration");
      } else {
        markNeedsCodex(job.id, job.state, "recovered from restart");
      }
    } catch {
      // Best-effort recovery; leave a terminal marker if state drift prevented transition.
      try {
        saveJob({ ...job, terminalReason: "recovery blocked", state: "NEEDS_CODEX", phase: "recovery_failed" });
      } catch {
        /* ignore */
      }
    }
  }
}

function markNeedsCodex(jobId: string, state: JobState, reason: string): void {
  try {
    transition(jobId, state, "NEEDS_CODEX", "needs_codex", { terminalReason: reason });
  } catch {
    // No legal fallback from this state; best effort only.
  }
}

recoverInterruptedJobs();

function readArtifactSafe(jobId: string, name: string): string | null {
  try {
    return readArtifact(jobId, name);
  } catch {
    return null;
  }
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function shouldRunReview(contract: ValidatedContract["canonical"]): boolean {
  const policy = contract.review?.policy ?? "on-risk";
  if (policy === "never") return false;
  if (policy === "always") return true;
  return contract.metadata.risk !== "low";
}

function asReviewModes(raw: string[] | undefined): ReviewMode[] {
  if (!raw || raw.length === 0) return ["standard"];
  return raw.filter((mode): mode is ReviewMode => mode === "standard" || mode === "adversarial" || mode === "security" || mode === "design");
}

function readReviewArtifact(jobId: string): StoredReviewArtifact | null {
  const raw = readArtifactSafe(jobId, "review.json");
  const parsed = safeJsonParse<StoredReviewArtifact>(raw);
  return parsed;
}

function readDispositions(jobId: string): DispositionRecord[] {
  const raw = readArtifactSafe(jobId, "findings-dispositions.json");
  const parsed = safeJsonParse<DispositionRecord[]>(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function confirmedFindingIds(dispositions: DispositionRecord[]): string[] {
  return dispositions.filter((item) => item.disposition === "confirmed").map((item) => item.findingId);
}

function rollbackWorkingTree(root: string): void {
  // Best-effort rollback path for apply failures. PRD 23.6 calls for rollback-safe behavior.
  git(["-C", root, "restore", "."]);
  git(["-C", root, "clean", "-fd"]);
}

function reintegrateStaleCandidate(
  job: JobRecord,
  contract: Contract,
  expectedPatch: string,
  currentHead: string,
): { ok: boolean; reason: string; patchHash?: string; baseCommit?: string; changedFiles: string[] } {
  const worktreeDir = join(worktreesDir(), `stale-${job.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);

  const fail = (reason: string): { ok: false; reason: string; changedFiles: string[] } => ({ ok: false, reason, changedFiles: [] });

  try {
    const created = addWorktree(job.repoRoot, currentHead, worktreeDir);
    if (!created.ok) return fail(`stale base integration worktree failed: ${created.stderr.trim()}`);

    const apply = git(["-C", worktreeDir, "apply", "--3way", "--whitespace=nowarn", "-"], expectedPatch);
    if (!apply.ok) {
      try {
        const message = apply.stderr.trim() || "patch failed to apply";
        transition(job.id, "STALE", "NEEDS_CODEX", "stale_reintegration_conflict", { terminalReason: `stale integration conflict: ${message}` });
      } catch {
        markNeedsCodex(job.id, "STALE", `stale integration conflict: ${apply.stderr.trim() || "patch failed to apply"}`);
      }
      return fail(`stale integration conflict: ${apply.stderr.trim() || "patch failed to apply"}`);
    }

    const candidate = extractCandidate(worktreeDir);
    if (candidate.changes.length === 0) {
      markNeedsCodex(job.id, "STALE", "stale integration produced no changes");
      return fail("stale integration produced no changes");
    }

    const policy = checkPolicy(contract, candidate.changes, candidate.patch);
    if (!policy.ok) {
      try {
        transition(job.id, "STALE", "FAILED_POLICY", `stale policy violations: ${policy.violations.map((v) => v.code).join(", ")}`,);
      } catch {
        markNeedsCodex(job.id, "STALE", `stale policy violations: ${policy.violations.map((v) => `${v.code}${v.path ? " " + v.path : ""}`).join(", ")}`);
      }
      return fail(`stale policy violations: ${policy.violations.map((v) => `${v.code}${v.path ? " " + v.path : ""}`).join(", ")}`);
    }

    const verification = verify(job.repoRoot, currentHead, contract, candidate);
    if (!verification.ok) {
      try {
        transition(job.id, "STALE", "FAILED_VERIFICATION", `stale verification failed: ${verification.reason}`);
      } catch {
        markNeedsCodex(job.id, "STALE", `stale verification failed: ${verification.reason}`);
      }
      return fail(`stale verification failed: ${verification.reason}`);
    }

    const receipt = buildReceipt(
      { ...job, state: "READY_TO_APPLY", baseCommit: currentHead, patchHash: candidate.patchHash },
      contract,
      candidate.changes,
      policy,
      verification,
      "stale reintegration",
    );

    writeArtifact(job.id, "candidate.patch", candidate.patch);
    writeArtifact(job.id, "policy.json", JSON.stringify(policy, null, 2));
    writeArtifact(job.id, "verification.json", JSON.stringify(verification, null, 2));
    writeArtifact(job.id, "receipt.json", JSON.stringify(receipt, null, 2));

    const refreshed = transition(job.id, "STALE", "READY_TO_APPLY", "stale_reintegrated", {
      baseCommit: currentHead,
      patchHash: candidate.patchHash,
      terminalReason: undefined,
      prepareToken: undefined,
    });
    if (refreshed.state !== "READY_TO_APPLY") return fail(`failed to finalize stale reintegration from ${refreshed.state}`);
    return { ok: true, reason: "ready", patchHash: candidate.patchHash, baseCommit: currentHead, changedFiles: candidate.changes.map((c) => c.path) };
  } finally {
    removeWorktree(job.repoRoot, worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// ---- run -----------------------------------------------------------------

// Live jobs → their cancellation controller. Present only while the worker runs; killing
// the worker we spawned (not a stored PID) avoids PID-reuse hazards (PRD T-07, NFR-011).
const running = new Map<string, AbortController>();

interface PipelineOptions {
  parentJobId?: string;
  repairRound?: number;
}

interface Started {
  job: JobRecord;
  done: Promise<JobOutcome>;
}

/** Validate preconditions, create the job, and launch the pipeline in the background. */
function beginJob(vc: ValidatedContract, ownerSession: string, options: PipelineOptions = {}): Started {
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
    parentJobId: options.parentJobId,
    repairRound: options.repairRound ?? 0,
    state: "CREATED",
    phase: "queued",
    isolationMode: "standard",
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);
  writeArtifact(jobId, "contract.json", JSON.stringify(contract, null, 2));

  const controller = new AbortController();
  running.set(jobId, controller);
  const done = runPipeline(jobId, vc, base, controller)
    .catch((e): JobOutcome => {
      // Unexpected internal error: fail closed to a terminal state.
      const j = getJob(jobId);
      if (j && !TERMINAL.has(j.state)) {
        saveJob({ ...j, state: "ENVIRONMENT_FAILURE", phase: "internal_error", terminalReason: e instanceof Error ? e.message : String(e) });
        appendEvent(jobId, { type: "internal_error", error: String(e) });
      }
      return { job: getJob(jobId)!, workerSummary: "", changes: [], artifacts: {} };
    })
    .finally(() => running.delete(jobId));

  return { job: getJob(jobId)!, done };
}

/** Start a job and return immediately with its initial record (async delegation). */
export function startJob(vc: ValidatedContract, ownerSession: string): JobRecord {
  const s = beginJob(vc, ownerSession);
  s.done.catch(() => {}); // outcome is recorded on the job; don't leak an unhandled rejection
  return s.job;
}

/** Start a job and await its terminal outcome (used by tests and callers that want the result). */
export async function runJob(vc: ValidatedContract, ownerSession: string): Promise<JobOutcome> {
  return beginJob(vc, ownerSession).done;
}

export interface ReviewSummary {
  review: StoredReviewArtifact;
  canCreateRepair: boolean;
  confirmedFindingIds: string[];
  acceptedCount: number;
}

export async function runPatchbayReview(
  jobId: string,
  overrides: {
    profile?: string;
    modes?: ReviewMode[];
    timeoutSec?: number;
    maxOutputBytes?: number;
    expectedPatchHash?: string;
  } = {},
): Promise<ReviewSummary> {
  const job = getJob(jobId);
  if (!job) throw new PipelineError(`job ${jobId} not found`, "job_not_found");
  if (!job.patchHash) throw new PipelineError(`job ${jobId} has no patch hash`, "invalid_state");
  if (overrides.expectedPatchHash && overrides.expectedPatchHash !== job.patchHash) {
    throw new PipelineError(`expected patch hash mismatch for job ${jobId}`, "validation_error");
  }

  const contract = readJobContract(jobId);
  if (!contract) throw new PipelineError(`job ${jobId} has no readable contract artifact`, "invalid_artifact");
  const patch = readArtifact(jobId, "candidate.patch");
  if (job.state !== "VERIFIED" && job.state !== "REVIEWED" && job.state !== "CHANGES_REQUESTED" && job.state !== "READY_TO_APPLY" && job.state !== "FAILED_REVIEW") {
    throw new PipelineError(`review is not valid from state ${job.state}`, "invalid_state");
  }
  const shouldTransition = job.state === "VERIFIED";
  if (shouldTransition) {
    transition(jobId, "VERIFIED", "REVIEWING", "review_started");
  }

  const reviewModes = overrides.modes ?? asReviewModes(contract.review?.modes);
  const reviewResult = await runReview({
    contract,
    patch,
    profile: overrides.profile ?? contract.review?.profile,
    modes: reviewModes,
    timeoutSec: overrides.timeoutSec,
    maxOutputBytes: overrides.maxOutputBytes,
  });
  const review: StoredReviewArtifact = {
    reviewedAt: new Date().toISOString(),
    profile: reviewResult.usedProfile,
    modes: reviewModes,
    verdict: reviewResult.verdict,
    findings: reviewResult.findings,
    uncertainties: reviewResult.uncertainties,
    parseStatus: reviewResult.parseStatus,
    parseError: reviewResult.parseError,
    raw: reviewResult.raw,
    reviewHash: reviewResult.reviewHash,
  };
  writeArtifact(jobId, "review.json", JSON.stringify(review, null, 2));

  if (!reviewResult.ok) {
    if (shouldTransition) transition(jobId, "REVIEWING", "FAILED_REVIEW", "review_failed", { terminalReason: reviewResult.parseError ?? reviewResult.rawCommand });
    throw new PipelineError(`review failed for ${jobId}: ${reviewResult.parseError ?? reviewResult.rawCommand}`, "review_failed");
  }
  if (shouldTransition) {
    transition(jobId, "REVIEWING", "REVIEWED", "reviewed");
    if (reviewResult.findings.length === 0) {
      transition(jobId, "REVIEWED", "READY_TO_APPLY", "ready_to_apply");
    } else {
      transition(jobId, "REVIEWED", "CHANGES_REQUESTED", "findings_found");
    }
  }

  const confirmed = confirmedFindingIds(readDispositions(jobId));
  return {
    review,
    canCreateRepair: confirmed.length > 0,
    confirmedFindingIds: confirmed,
    acceptedCount: review.findings.length,
  };
}

export interface SubmitFindingDispositionsArgs {
  jobId: string;
  reviewHash: string;
  dispositions: FindingDispositionInput[];
}

export interface SubmitFindingDispositionsResult {
  ok: boolean;
  reason: string;
  acceptedCount: number;
  confirmedCount: number;
  canCreateRepair: boolean;
}

export function submitFindingDispositions(args: SubmitFindingDispositionsArgs): SubmitFindingDispositionsResult {
  const job = getJob(args.jobId);
  if (!job) return { ok: false, reason: `job ${args.jobId} not found`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
  if (job.state !== "REVIEWED" && job.state !== "CHANGES_REQUESTED") {
    return { ok: false, reason: `job ${args.jobId} is in state ${job.state}; expected REVIEWED/CHANGES_REQUESTED`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
  }
  const review = readReviewArtifact(args.jobId);
  if (!review) return { ok: false, reason: `job ${args.jobId} has no review artifact`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
  if (review.reviewHash !== args.reviewHash) return { ok: false, reason: `review hash mismatch for job ${args.jobId}`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };

  const findingIds = new Set(review.findings.map((finding) => finding.id));
  const seen = new Set<string>();
  const entries: DispositionRecord[] = [];
  for (const disposition of args.dispositions) {
    if (!findingIds.has(disposition.id)) return { ok: false, reason: `unknown finding id ${disposition.id}`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
    if (!ALLOWED_REVIEW_DISPOSITIONS.has(disposition.disposition)) return { ok: false, reason: `invalid disposition ${disposition.disposition} for finding ${disposition.id}`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
    if (seen.has(disposition.id)) return { ok: false, reason: `duplicate finding id ${disposition.id}`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
    seen.add(disposition.id);
    const finding = review.findings.find((f) => f.id === disposition.id);
    entries.push({
      findingId: disposition.id,
      file: finding?.file,
      line: finding?.line,
      category: finding?.category,
      disposition: disposition.disposition,
      reportedAt: new Date().toISOString(),
    });
  }
  for (const required of findingIds) {
    if (!seen.has(required)) return { ok: false, reason: `missing disposition for finding ${required}`, acceptedCount: 0, confirmedCount: 0, canCreateRepair: false };
  }
  writeArtifact(args.jobId, "findings-dispositions.json", JSON.stringify(entries, null, 2));

  const confirmed = confirmedFindingIds(entries);
  if (confirmed.length > 0 && job.state === "REVIEWED") {
    transition(args.jobId, "REVIEWED", "CHANGES_REQUESTED", "confirmed findings require repair");
  } else if (confirmed.length === 0 && job.state === "REVIEWED") {
    transition(args.jobId, "REVIEWED", "READY_TO_APPLY", "all findings de-escalated");
  } else if (confirmed.length === 0 && job.state === "CHANGES_REQUESTED") {
    transition(args.jobId, "CHANGES_REQUESTED", "READY_TO_APPLY", "all findings de-escalated");
  }

  return {
    ok: true,
    reason: `accepted ${entries.length} findings`,
    acceptedCount: entries.length,
    confirmedCount: confirmed.length,
    canCreateRepair: confirmed.length > 0,
  };
}

interface RepairContractOptions {
  parentJobId: string;
  expectedPatchHash: string;
  expectedReviewHash: string;
  confirmedFindingIds: string[];
  workerProfile?: string;
}

interface RepairStartResult {
  ok: boolean;
  reason: string;
  childJobId?: string;
  parentJobId?: string;
}

function buildRepairContract(contract: ValidatedContract["canonical"], confirmedFindings: { id: string; claim: string; file?: string; line?: number }[]): Contract {
  const instructions = confirmedFindings.length
    ? `\n\nRepair instructions:\n${confirmedFindings.map((finding) => `- [${finding.id}] ${finding.file ?? "?"}${finding.line ? `:${finding.line}` : ""} ${finding.claim}`).join("\n")}`
    : "";
  return {
    ...contract,
    objective: `${contract.objective}${instructions}`,
    worker: {
      ...contract.worker,
      profile: contract.worker.profile,
    },
  };
}

export async function startRepairJob(args: RepairContractOptions): Promise<RepairStartResult> {
  const source = getJob(args.parentJobId);
  if (!source) return { ok: false, reason: "parent job not found" };
  if (!source.patchHash || source.patchHash !== args.expectedPatchHash) return { ok: false, reason: "parent patch hash mismatch" };
  if (source.state !== "CHANGES_REQUESTED") {
    return { ok: false, reason: `source job must be CHANGES_REQUESTED, found ${source.state}` };
  }

  const review = readReviewArtifact(source.id);
  if (!review) return { ok: false, reason: "parent job has no review artifact" };
  if (review.reviewHash !== args.expectedReviewHash) return { ok: false, reason: "review hash mismatch" };
  const contract = readJobContract(source.id);
  if (!contract) return { ok: false, reason: "parent contract is unreadable" };
  const parentVc = validateContract(contract);
  const validFindingIds = new Set(review.findings.map((f) => f.id));
  for (const id of args.confirmedFindingIds) {
    if (!validFindingIds.has(id)) return { ok: false, reason: `finding id ${id} is not in review findings` };
  }
  const dispositions = readDispositions(source.id);
  const confirmed = new Set(confirmedFindingIds(dispositions));
  for (const id of args.confirmedFindingIds) {
    if (!confirmed.has(id)) return { ok: false, reason: `finding ${id} is not confirmed` };
  }
  if (!args.confirmedFindingIds.length) return { ok: false, reason: "no confirmed findings provided" };

  const nextRound = (source.repairRound ?? 0) + 1;
  if (nextRound > parentVc.canonical.budget.max_repair_rounds) {
    return { ok: false, reason: `repair budget exceeded (limit ${parentVc.canonical.budget.max_repair_rounds})` };
  }

  const confirmedFindings = review.findings.filter((finding) => args.confirmedFindingIds.includes(finding.id));
  const objectiveContract = buildRepairContract(parentVc.canonical, confirmedFindings);
  const workerProfile = args.workerProfile ?? parentVc.canonical.worker.profile;
  const repairContract = { ...objectiveContract, worker: { ...objectiveContract.worker, profile: workerProfile } };
  const repairVc = validateContract(repairContract);
  const started = beginJob(repairVc, source.ownerSession, {
    parentJobId: source.id,
    repairRound: nextRound,
  });
  try {
    transition(source.id, "CHANGES_REQUESTED", "REPAIR_QUEUED", "repair_requested");
  } catch {
    appendEvent(source.id, { type: "repair_requested", childJobId: started.job.id });
  }
  saveJob({ ...source, repairRound: nextRound });
  appendEvent(source.id, { type: "repair_requested", childJobId: started.job.id, findingIds: args.confirmedFindingIds });
  return { ok: true, reason: `created repair job ${started.job.id}`, childJobId: started.job.id, parentJobId: source.id };
}

export interface ReceiptFilter {
  allJobs?: boolean;
  ownerSession?: string;
  state?: string;
  includeTerminalOnly?: boolean;
  limit?: number;
}

export interface ReceiptSummary {
  jobId: string;
  parentJobId?: string;
  state: JobState;
  ownerSession: string;
  risk: string;
  worker: string;
  isolationMode: "standard" | "secure" | "unsafe-dev";
  repairRound: number;
  taskHash: string;
  patchHash?: string;
  baseCommit: string;
  changedFiles: string[];
  changedCount: number;
  verifiedOk?: boolean;
  policyOk?: boolean;
  review?: {
    verdict: string;
    findingCount: number;
    confirmedFindingCount: number;
    parseStatus: string;
  };
  createdAt: string;
  updatedAt: string;
}

export function listReceipts(filter: ReceiptFilter = {}): ReceiptSummary[] {
  const raw = listJobs().filter((job) => {
    if (!filter.allJobs && filter.ownerSession && job.ownerSession !== filter.ownerSession) return false;
    if (filter.state && job.state !== filter.state) return false;
    if (filter.includeTerminalOnly && !TERMINAL.has(job.state)) return false;
    return true;
  });
  const summary = raw.map((job) => {
    const review = readReviewArtifact(job.id);
    const dispositions = readDispositions(job.id);
    const policy = safeJsonParse<{ ok?: boolean }>(readArtifactSafe(job.id, "policy.json"));
    const verification = safeJsonParse<{ ok?: boolean }>(readArtifactSafe(job.id, "verification.json"));
    const receipt = safeJsonParse<{ changed_files?: { path: string }[] }>(readArtifactSafe(job.id, "receipt.json"));
    const changedFiles = (receipt?.changed_files ?? []).map((c) => c.path);
    return {
      jobId: job.id,
      parentJobId: job.parentJobId,
      state: job.state,
      ownerSession: job.ownerSession,
      risk: job.risk,
      worker: job.workerProfile,
      isolationMode: job.isolationMode,
      repairRound: job.repairRound ?? 0,
      taskHash: job.taskHash,
      patchHash: job.patchHash,
      baseCommit: job.baseCommit,
      changedFiles,
      changedCount: changedFiles.length,
      verifiedOk: verification?.ok,
      policyOk: policy?.ok,
      review: review
        ? {
            verdict: review.verdict,
            findingCount: review.findings.length,
            confirmedFindingCount: confirmedFindingIds(dispositions).length,
            parseStatus: review.parseStatus,
          }
        : undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });
  return summary.slice(0, filter.limit ?? 30);
}

/** Request cancellation. Aborts a live worker; otherwise force-cancels a stuck non-terminal job. */
export function cancelJob(
  jobId: string,
  ownerSession?: string,
  forceCrossSession = false,
): { ok: boolean; reason: string } {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "job not found" };
  if (ownerSession && job.ownerSession !== ownerSession && !forceCrossSession) {
    return {
      ok: false,
      reason: `job ${jobId} is owned by a different session; set forceCrossSession to true to request cross-session cancellation`,
    };
  }
  if (TERMINAL.has(job.state)) return { ok: false, reason: `job already terminal (${job.state})` };
  const controller = running.get(jobId);
  if (controller) {
    if (!["CANCEL_REQUESTED", "CANCELLED"].includes(job.state)) {
      try {
        transition(jobId, job.state, "CANCEL_REQUESTED", "cancel_requested", { terminalReason: "cancel requested by user" });
      } catch {
        // best effort transition so request can still be forwarded.
      }
      appendEvent(jobId, { type: "cancel_requested", state: job.state });
    }
    controller.abort();
    return { ok: true, reason: "cancellation requested; worker is being terminated" };
  }
  // No live worker (past the worker phase, or a stale job after a restart).
  try {
    transition(jobId, job.state, "CANCELLED", "cancelled", { terminalReason: "cancelled by request" });
    return { ok: true, reason: "job cancelled" };
  } catch {
    return { ok: false, reason: "job is past the worker phase and will finish shortly" };
  }
}

async function runPipeline(jobId: string, vc: ValidatedContract, base: string, controller: AbortController): Promise<JobOutcome> {
  const { canonical: contract } = vc;
  const root = contract.repository.root;
  const artifacts: Record<string, string> = {};
  const worktreeDir = join(worktreesDir(), `job-${jobId}`);
  if (!getJob(jobId)) throw new PipelineError(`job ${jobId} missing while starting`, "job_not_found");
  const requestCancel = (): JobRecord | null => {
    const job = getJob(jobId);
    if (!job || TERMINAL.has(job.state)) return null;
    try {
      return transition(jobId, job.state, "CANCELLED", "cancelled", { terminalReason: "cancelled by request" });
    } catch {
      return null;
    }
  };

  try {
    transition(jobId, "CREATED", "VALIDATED", "validated");
    transition(jobId, "VALIDATED", "SNAPSHOTTED", "snapshotted");

    const created = addWorktree(root, base, worktreeDir);
    if (!created.ok) {
      terminate(jobId, "SNAPSHOTTED", "ENVIRONMENT_FAILURE", `worktree failed: ${created.stderr.trim()}`, "worktree");
      return { job: getJob(jobId)!, workerSummary: "", changes: [], artifacts };
    }
    transition(jobId, "SNAPSHOTTED", "WORKTREE_READY", "worktree_ready");
    if (controller.signal.aborted) {
      const canceled = requestCancel();
      return { job: canceled ?? getJob(jobId)!, workerSummary: "", changes: [], artifacts };
    }

    transition(jobId, "WORKTREE_READY", "QUEUED", "queued");
    if (controller.signal.aborted) {
      const canceled = requestCancel();
      return { job: canceled ?? getJob(jobId)!, workerSummary: "", changes: [], artifacts };
    }

    // Worker.
    transition(jobId, "QUEUED", "RUNNING_WORKER", "running_worker");
    const runtime = getRuntime(contract.worker.profile);
    const worker = await runtime.run({ worktreeDir, contract, signal: controller.signal }).catch((e) => ({
      ok: false as const,
      summary: e instanceof Error ? e.message : String(e),
      log: e instanceof Error ? (e.stack ?? e.message) : String(e),
    }));
    artifacts["worker-log.txt"] = writeArtifact(jobId, "worker-log.txt", worker.log);

    // Past the worker phase — cancellation window closes; the fast tail always completes.
    running.delete(jobId);

    if (controller.signal.aborted) {
      const canceled = requestCancel();
      return canceled ? { job: canceled, workerSummary: worker.summary, changes: [], artifacts } : { job: getJob(jobId)!, workerSummary: worker.summary, changes: [], artifacts };
    }
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

    let review: StoredReviewArtifact | undefined;
    if (shouldRunReview(contract)) {
      transition(jobId, "VERIFIED", "REVIEWING", "review_started");
      const reviewModes = asReviewModes(contract.review?.modes);
      const reviewResult = await runReview({
        contract,
        patch: candidate.patch,
        profile: contract.review?.profile,
        modes: reviewModes,
      });
      review = {
        reviewedAt: new Date().toISOString(),
        profile: reviewResult.usedProfile,
        modes: reviewModes,
        verdict: reviewResult.verdict,
        findings: reviewResult.findings,
        uncertainties: reviewResult.uncertainties,
        parseStatus: reviewResult.parseStatus,
        parseError: reviewResult.parseError,
        raw: reviewResult.raw,
        reviewHash: reviewResult.reviewHash,
      };
      artifacts["review.json"] = writeArtifact(jobId, "review.json", JSON.stringify(review, null, 2));
      if (!reviewResult.ok) {
        terminate(jobId, "REVIEWING", "FAILED_REVIEW", reviewResult.parseError ?? reviewResult.rawCommand, "review_failed");
        return {
          job: getJob(jobId)!,
          workerSummary: worker.summary,
          changes: candidate.changes,
          review,
          policy,
          verification,
          artifacts,
        };
      }
      transition(jobId, "REVIEWING", "REVIEWED", "reviewed");
      if (reviewResult.findings.length === 0) {
        transition(jobId, "REVIEWED", "READY_TO_APPLY", "ready_to_apply");
      } else {
        transition(jobId, "REVIEWED", "CHANGES_REQUESTED", "findings_found");
      }
    } else {
      transition(jobId, "VERIFIED", "READY_TO_APPLY", "ready_to_apply");
    }

    const receipt = buildReceipt(
      getJob(jobId)!,
      contract,
      candidate.changes,
      policy,
      verification,
      worker.summary,
    );
    artifacts["receipt.json"] = writeArtifact(jobId, "receipt.json", JSON.stringify(receipt, null, 2));

    return { job: getJob(jobId)!, workerSummary: worker.summary, changes: candidate.changes, review, policy, verification, artifacts };
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

export interface VerificationRunArgs {
  jobId: string;
  expectedPatchHash?: string;
}

export interface VerificationRunResult {
  ok: boolean;
  jobId: string;
  reason: string;
  baseCommit: string;
  patchHash: string;
  checks: unknown[];
  reregisteredHash: string;
}

export interface JobLogsArgs {
  jobId: string;
  includeWorkerLog?: boolean;
  includeReview?: boolean;
  includePolicy?: boolean;
  includeVerification?: boolean;
  includeReceipt?: boolean;
  includeContract?: boolean;
  includePatch?: boolean;
  includeEvents?: boolean;
  stream?: string;
  cursor?: number;
  maxBytes?: number;
  maxChars?: number;
}

export interface JobLogsResult {
  jobId: string;
  lines: string[];
  truncated: boolean;
  nextCursor: string | null;
  limits: {
    maxBytes: number;
    maxChars: number;
  };
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
  if (!head) return { ...plan, reason: "unable to read HEAD commit" };
  if (head !== job.baseCommit) {
    const reason = "stale base: HEAD moved since verification; re-integration required";
    try {
      transition(jobId, "READY_TO_APPLY", "STALE", "stale_base", { terminalReason: reason });
    } catch {
      const now = getJob(jobId);
      if (now?.state !== "READY_TO_APPLY") {
        return { ...plan, reason: `job state is ${now?.state ?? job.state}, expected READY_TO_APPLY` };
      }
    }
    const contract = readJobContract(jobId);
    if (!contract) {
      markNeedsCodex(jobId, "STALE", "missing contract artifact; cannot re-integrate stale candidate");
      return { ...plan, reason: "missing contract artifact; cannot re-integrate stale candidate" };
    }

    const patch = readArtifact(jobId, "candidate.patch");
    if (sha256(patch) !== job.patchHash) {
      markNeedsCodex(jobId, "STALE", "stored patch hash mismatch (tampered artifact)");
      return { ...plan, reason: "stored patch hash mismatch (tampered artifact)" };
    }
    const integration = reintegrateStaleCandidate({ ...job, state: "STALE", baseCommit: head, terminalReason: reason }, contract, patch, head);
    if (!integration.ok) return { ...plan, reason: integration.reason };
    const refreshed = getJob(jobId);
    if (!refreshed || refreshed.state !== "READY_TO_APPLY") return { ...plan, reason: `job state is ${refreshed?.state ?? "missing"}, expected READY_TO_APPLY` };
    const token = randomBytes(16).toString("hex");
    saveJob({ ...refreshed, prepareToken: token });
    return {
      ready: true,
      reason: integration.reason,
      jobId,
      currentHead: head,
      expectedBase: integration.baseCommit ?? head,
      patchHash: integration.patchHash,
      changedFiles: integration.changedFiles,
      prepareToken: token,
    };
  }
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

/** Re-run clean verification for a stored job from its artifacts. */
export function verifyCandidate(args: VerificationRunArgs): VerificationRunResult {
  const job = getJob(args.jobId);
  if (!job) {
    return { ok: false, jobId: args.jobId, reason: "job not found", baseCommit: "", patchHash: "", checks: [], reregisteredHash: "" };
  }
  if (job.state === "CREATED") {
    return {
      ok: false,
      jobId: job.id,
      reason: "job not yet producing a candidate",
      baseCommit: job.baseCommit,
      patchHash: job.patchHash ?? "",
      checks: [],
      reregisteredHash: job.patchHash ?? "",
    };
  }

  const contract = readJobContract(args.jobId);
  if (!contract) {
    return { ok: false, jobId: job.id, reason: "missing contract artifact", baseCommit: job.baseCommit, patchHash: job.patchHash ?? "", checks: [], reregisteredHash: "" };
  }

  const patch = readArtifactSafe(args.jobId, "candidate.patch");
  if (!patch) {
    return { ok: false, jobId: job.id, reason: "missing candidate patch artifact", baseCommit: job.baseCommit, patchHash: job.patchHash ?? "", checks: [], reregisteredHash: "" };
  }

  const expected = sha256(patch);
  if (args.expectedPatchHash && args.expectedPatchHash !== expected) {
    return {
      ok: false,
      jobId: job.id,
      reason: "patch hash mismatch",
      baseCommit: job.baseCommit,
      patchHash: expected,
      checks: [],
      reregisteredHash: expected,
    };
  }

  const receipt = verify(job.repoRoot, job.baseCommit, contract, {
    changes: [],
    patch,
    patchHash: expected,
  });
  const key = `verification-recheck-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.json`;
  writeArtifact(job.id, key, JSON.stringify(receipt, null, 2));
  appendEvent(job.id, { type: "verification_rerun", patchHash: expected, ok: receipt.ok, reason: receipt.reason });

  return {
    ok: receipt.ok,
    jobId: job.id,
    reason: receipt.reason,
    baseCommit: receipt.baseCommit,
    patchHash: receipt.patchHash,
    checks: receipt.checks,
    reregisteredHash: receipt.patchHash,
  };
}

/** Read job logs for diagnostics. Supports bounded, best-effort bounded concatenation. */
export function readJobLogs(args: JobLogsArgs): JobLogsResult {
  const job = getJob(args.jobId);
  if (!job) throw new PipelineError(`job ${args.jobId} not found`, "job_not_found");

  const maxBytes = Math.max(256, Math.min(args.maxBytes ?? args.maxChars ?? 12000, 24000));
  const cursor = Number.isFinite(args.cursor) && args.cursor !== undefined ? Math.max(0, Math.floor(args.cursor)) : 0;
  const stream = (() => {
    const raw = typeof args.stream === "string" ? args.stream.trim().toLowerCase() : "";
    return raw.replace(/[\s_]/g, "-");
  })();

  const parts: string[] = [];
  const pushLine = (label: string, body: string | null) => {
    if (body == null) return;
    parts.push(`## ${label}`);
    parts.push(body);
  };

  const readEventsTail = (): string | null => {
    try {
      const path = jobEventsPath(job.id);
      const events = readFileSync(path, "utf8").trim();
      if (!events) return null;
      return events.split("\n").slice(-200).join("\n");
    } catch {
      return null;
    }
  };

  const hasExplicitSelectors =
    args.stream !== undefined ||
    args.includeWorkerLog !== undefined ||
    args.includeReview !== undefined ||
    args.includePolicy !== undefined ||
    args.includeVerification !== undefined ||
    args.includeReceipt !== undefined ||
    args.includeContract !== undefined ||
    args.includePatch !== undefined ||
    args.includeEvents !== undefined;

  const addSelectedStream = (name: string): void => {
    switch (name) {
      case "all":
        pushLine("worker-log.txt", readArtifactSafe(job.id, "worker-log.txt"));
        pushLine("review.json", readArtifactSafe(job.id, "review.json"));
        pushLine("policy.json", readArtifactSafe(job.id, "policy.json"));
        pushLine("verification.json", readArtifactSafe(job.id, "verification.json"));
        pushLine("receipt.json", readArtifactSafe(job.id, "receipt.json"));
        pushLine("contract.json", readArtifactSafe(job.id, "contract.json"));
        pushLine("candidate.patch", readArtifactSafe(job.id, "candidate.patch"));
        pushLine("events.jsonl", readEventsTail());
        break;
      case "worker-log":
      case "worker":
      case "worker-log.txt":
        pushLine("worker-log.txt", readArtifactSafe(job.id, "worker-log.txt"));
        break;
      case "review":
        pushLine("review.json", readArtifactSafe(job.id, "review.json"));
        break;
      case "policy":
        pushLine("policy.json", readArtifactSafe(job.id, "policy.json"));
        break;
      case "verification":
        pushLine("verification.json", readArtifactSafe(job.id, "verification.json"));
        break;
      case "receipt":
        pushLine("receipt.json", readArtifactSafe(job.id, "receipt.json"));
        break;
      case "contract":
        pushLine("contract.json", readArtifactSafe(job.id, "contract.json"));
        break;
      case "patch":
        pushLine("candidate.patch", readArtifactSafe(job.id, "candidate.patch"));
        break;
      case "events":
      case "event":
        pushLine("events.jsonl", readEventsTail());
        break;
      default:
        throw new PipelineError(`unknown stream selector: ${name}`, "bad_request");
    }
  };

  if (stream) {
    addSelectedStream(stream);
  } else if (args.includeWorkerLog || args.includeReview || args.includePolicy || args.includeVerification || args.includeReceipt || args.includeContract || args.includePatch || args.includeEvents) {
    if (args.includeWorkerLog) pushLine("worker-log.txt", readArtifactSafe(job.id, "worker-log.txt"));
    if (args.includeReview) pushLine("review.json", readArtifactSafe(job.id, "review.json"));
    if (args.includePolicy) pushLine("policy.json", readArtifactSafe(job.id, "policy.json"));
    if (args.includeVerification) pushLine("verification.json", readArtifactSafe(job.id, "verification.json"));
    if (args.includeReceipt) pushLine("receipt.json", readArtifactSafe(job.id, "receipt.json"));
    if (args.includeContract) pushLine("contract.json", readArtifactSafe(job.id, "contract.json"));
    if (args.includePatch) pushLine("candidate.patch", readArtifactSafe(job.id, "candidate.patch"));
    if (args.includeEvents) pushLine("events.jsonl", readEventsTail());
  } else if (!hasExplicitSelectors) {
    pushLine("worker-log.txt", readArtifactSafe(job.id, "worker-log.txt"));
    const events = readEventsTail();
    if (events) pushLine("events.jsonl", events);
  }

  const raw = parts.join("\n");
  const start = Math.min(Math.max(cursor, 0), raw.length);
  const chunk = raw.slice(start, start + maxBytes);
  const truncated = start + chunk.length < raw.length;

  return {
    jobId: job.id,
    lines: [chunk],
    truncated,
    nextCursor: truncated ? String(start + chunk.length) : null,
    limits: { maxBytes, maxChars: maxBytes },
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
  if (!applied.ok) {
    rollbackWorkingTree(job.repoRoot);
    return { ok: false, reason: `apply failed: ${applied.stderr.trim()}`, appliedFiles: 0 };
  }

  const appliedHash = appliedPatchHash(job.repoRoot);
  if (appliedHash !== job.patchHash) {
    rollbackWorkingTree(job.repoRoot);
    return {
      ok: false,
      reason: `patch hash mismatch after apply: expected ${job.patchHash} got ${appliedHash}`,
      appliedFiles: 0,
    };
  }

  // Record the disposition. We keep the active tree hash check local, then transition to APPLIED.
  // This avoids staged/committed changes while retaining exact hash verification.
  transition(args.jobId, "READY_TO_APPLY", "APPLIED", "applied", { prepareToken: undefined });
  const receipt = JSON.parse(readArtifact(args.jobId, "receipt.json")) as Record<string, unknown>;
  receipt.state = "APPLIED";
  receipt.application_status = "applied";
  delete receipt.receipt_hash;
  receipt.receipt_hash = hashJson(receipt);
  writeArtifact(args.jobId, "receipt.json", JSON.stringify(receipt, null, 2));
  return { ok: true, reason: "applied", appliedFiles };
}

/** Read a stored job artifact (contract.json, candidate.patch, policy.json, …) or null. */
export function readJobArtifact(jobId: string, name: string): string | null {
  try {
    return readArtifact(jobId, name);
  } catch {
    return null;
  }
}
