// Durable job store + state machine (PRD 21, 22).
// ponytail: filesystem-backed (atomic JSON record + append-only event log), single
// writer. Survives restart, no native deps. Swap for SQLite behind this same interface
// when multi-process contention or rich queries justify it (PRD AD-05, open question #1).
import { writeFileSync, readFileSync, renameSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { jobsDir } from "./paths.ts";

export type JobState =
  | "CREATED"
  | "VALIDATED"
  | "SNAPSHOTTED"
  | "WORKTREE_READY"
  | "QUEUED"
  | "RUNNING_WORKER"
  | "PATCH_READY"
  | "POLICY_CHECK"
  | "VERIFYING"
  | "VERIFIED"
  | "REVIEWING"
  | "REVIEWED"
  | "CHANGES_REQUESTED"
  | "REPAIR_QUEUED"
  | "RUNNING_REPAIR"
  | "READY_TO_APPLY"
  | "APPLIED"
  | "FAILED_WORKER"
  | "FAILED_POLICY"
  | "FAILED_VERIFICATION"
  | "FAILED_REVIEW"
  | "BUDGET_EXCEEDED"
  | "CANCEL_REQUESTED"
  | "STALE"
  | "ENVIRONMENT_FAILURE"
  | "CANCELLED"
  | "NEEDS_HUMAN"
  | "NEEDS_CODEX"
  | "ARCHIVED";

// Legal transitions (compare-and-set enforced on top of this graph, PRD 21.4).
const TRANSITIONS: Record<JobState, JobState[]> = {
  CREATED: ["VALIDATED", "SNAPSHOTTED", "FAILED_WORKER", "CANCEL_REQUESTED", "CANCELLED"],
  VALIDATED: ["SNAPSHOTTED", "WORKTREE_READY", "ENVIRONMENT_FAILURE", "CANCEL_REQUESTED", "CANCELLED"],
  SNAPSHOTTED: ["WORKTREE_READY", "FAILED_WORKER", "ENVIRONMENT_FAILURE", "CANCEL_REQUESTED", "CANCELLED"],
  WORKTREE_READY: ["QUEUED", "FAILED_WORKER", "ENVIRONMENT_FAILURE", "CANCEL_REQUESTED", "CANCELLED"],
  QUEUED: ["RUNNING_WORKER", "FAILED_WORKER", "CANCEL_REQUESTED", "CANCELLED"],
  RUNNING_WORKER: ["PATCH_READY", "FAILED_WORKER", "CANCEL_REQUESTED", "CANCELLED"],
  PATCH_READY: ["POLICY_CHECK", "FAILED_WORKER", "CANCEL_REQUESTED", "CANCELLED", "NEEDS_HUMAN"],
  POLICY_CHECK: ["VERIFYING", "FAILED_POLICY", "CANCEL_REQUESTED", "CANCELLED", "NEEDS_HUMAN"],
  VERIFYING: ["VERIFIED", "FAILED_VERIFICATION", "ENVIRONMENT_FAILURE", "CANCEL_REQUESTED", "CANCELLED", "NEEDS_HUMAN"],
  VERIFIED: ["READY_TO_APPLY", "REVIEWING", "NEEDS_HUMAN", "CANCEL_REQUESTED", "CANCELLED", "BUDGET_EXCEEDED"],
  REVIEWING: ["REVIEWED", "FAILED_REVIEW", "CANCEL_REQUESTED", "CANCELLED", "NEEDS_CODEX"],
  REVIEWED: ["READY_TO_APPLY", "CHANGES_REQUESTED", "NEEDS_HUMAN", "CANCEL_REQUESTED", "CANCELLED"],
  CHANGES_REQUESTED: ["REPAIR_QUEUED", "READY_TO_APPLY", "NEEDS_HUMAN", "CANCEL_REQUESTED", "CANCELLED"],
  REPAIR_QUEUED: ["RUNNING_REPAIR", "FAILED_WORKER", "CANCEL_REQUESTED", "CANCELLED", "BUDGET_EXCEEDED", "NEEDS_HUMAN"],
  RUNNING_REPAIR: ["PATCH_READY", "FAILED_WORKER", "ENVIRONMENT_FAILURE", "CANCEL_REQUESTED", "CANCELLED"],
  READY_TO_APPLY: ["APPLIED", "NEEDS_HUMAN", "ARCHIVED", "CANCEL_REQUESTED", "CANCELLED", "STALE"],
  APPLIED: ["ARCHIVED", "NEEDS_HUMAN"],
  FAILED_WORKER: ["ARCHIVED", "NEEDS_CODEX", "CANCELLED"],
  FAILED_POLICY: ["ARCHIVED", "NEEDS_CODEX", "CANCELLED"],
  FAILED_VERIFICATION: ["ARCHIVED", "NEEDS_CODEX", "CANCELLED"],
  FAILED_REVIEW: ["ARCHIVED", "NEEDS_CODEX", "CANCELLED"],
  BUDGET_EXCEEDED: ["ARCHIVED", "NEEDS_CODEX", "CANCELLED"],
  STALE: ["READY_TO_APPLY", "CANCELLED", "ARCHIVED", "NEEDS_CODEX", "CANCEL_REQUESTED"],
  NEEDS_CODEX: ["ARCHIVED", "NEEDS_HUMAN", "CANCELLED"],
  ENVIRONMENT_FAILURE: ["ARCHIVED", "CANCELLED"],
  CANCEL_REQUESTED: ["CANCELLED", "NEEDS_HUMAN"],
  CANCELLED: ["ARCHIVED"],
  NEEDS_HUMAN: ["READY_TO_APPLY", "ARCHIVED", "CANCELLED", "NEEDS_CODEX"],
  ARCHIVED: [],
};

export const TERMINAL: ReadonlySet<JobState> = new Set([
  "APPLIED",
  "FAILED_WORKER",
  "FAILED_POLICY",
  "FAILED_VERIFICATION",
  "FAILED_REVIEW",
  "BUDGET_EXCEEDED",
  "ENVIRONMENT_FAILURE",
  "NEEDS_CODEX",
  "CANCELLED",
  "ARCHIVED",
]);

export interface JobRecord {
  id: string;
  repoId: string;
  repoRoot: string;
  ownerSession: string;
  taskHash: string;
  baseCommit: string;
  workerProfile: string;
  risk: string;
  parentJobId?: string;
  repairRound?: number;
  state: JobState;
  phase: string;
  isolationMode: "standard" | "secure" | "unsafe-dev";
  patchHash?: string;
  prepareToken?: string;
  terminalReason?: string;
  createdAt: string;
  updatedAt: string;
}

function recordPath(id: string): string {
  return join(jobsDir(), `${id}.json`);
}
function eventsPath(id: string): string {
  return join(jobsDir(), `${id}.events.jsonl`);
}

/** Path to durable transition/event log for a job. Useful for read-only diagnostics. */
export function jobEventsPath(id: string): string {
  return eventsPath(id);
}

/** Sortable job id: base36 timestamp prefix + random suffix. */
export function newJobId(): string {
  return `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(5).toString("hex")}`;
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveJob(job: JobRecord): void {
  job.updatedAt = new Date().toISOString();
  writeAtomic(recordPath(job.id), JSON.stringify(job, null, 2));
}

export function getJob(id: string): JobRecord | null {
  const p = recordPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as JobRecord;
}

export function listJobs(): JobRecord[] {
  return readdirSync(jobsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(jobsDir(), f), "utf8")) as JobRecord)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function appendEvent(id: string, event: Record<string, unknown>): void {
  appendFileSync(eventsPath(id), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
}

export class StateError extends Error {}

/**
 * Compare-and-set transition. Fails closed if the job is not currently in `from`
 * or the `from → to` edge is illegal (PRD 21.4, NFR-010).
 */
export function transition(id: string, from: JobState, to: JobState, phase: string, extra?: Partial<JobRecord>): JobRecord {
  const job = getJob(id);
  if (!job) throw new StateError(`job ${id} not found`);
  if (job.state !== from) throw new StateError(`expected state ${from}, found ${job.state}`);
  if (!TRANSITIONS[from].includes(to)) throw new StateError(`illegal transition ${from} → ${to}`);
  const prior = job.state;
  Object.assign(job, extra, { state: to, phase });
  saveJob(job);
  appendEvent(id, { type: "transition", from: prior, to, phase });
  return job;
}
