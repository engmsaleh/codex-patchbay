// Patchbay MCP server (STDIO). Milestone 1: doctor + the delegation/verify/apply tools
// backed by the local control plane. Tool names use the stable `patchbay_` prefix (PRD 20).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDoctor, formatDoctor } from "../doctor.ts";
import { PATCHBAY_VERSION } from "../version.ts";
import { validateContract } from "../contract.ts";
import {
  startJob,
  cancelJob,
  prepareApply,
  applyCandidate,
  readJobArtifact,
  runPatchbayReview,
  submitFindingDispositions,
  startRepairJob,
  listReceipts,
  verifyCandidate,
  readJobLogs,
  PipelineError,
} from "../pipeline.ts";
import { getJob, listJobs } from "../store.ts";

const server = new McpServer({ name: "patchbay", version: PATCHBAY_VERSION });

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string): Text => ({ content: [{ type: "text", text: s }] });
const err = (s: string): Text => ({ content: [{ type: "text", text: s }], isError: true });

const contractShape = { contract: z.record(z.string(), z.unknown()).describe("A Patchbay task contract (schema_version 1.0).") };
const currentSession = (extra?: { sessionId?: unknown }) =>
  typeof extra?.sessionId === "string" && extra.sessionId.trim() ? extra.sessionId : "codex";

server.registerTool(
  "patchbay_doctor",
  {
    title: "Patchbay doctor",
    description: "Read-only health check for runtimes, worker/reviewer profiles, sandbox, and the target repository. Never reveals credential values.",
    inputSchema: { path: z.string().optional().describe("Repository path to inspect. Defaults to the server's working directory.") },
  },
  async ({ path }) => text(formatDoctor(runDoctor({ path }))),
);

server.registerTool(
  "patchbay_estimate",
  {
    title: "Patchbay estimate",
    description: "Validate a draft task contract without running anything. Returns the task hash, risk, review policy, and hard limits.",
    inputSchema: contractShape,
  },
  async ({ contract }) => {
    try {
      const vc = validateContract(contract);
      const c = vc.canonical;
      return text(
        [
          `Contract valid.`,
          `task_hash: ${vc.taskHash}`,
          `risk: ${c.metadata.risk}`,
          `worker: ${c.worker.profile}`,
          `review policy: ${c.review?.policy ?? "on-risk"}`,
          `scope: allow=${c.scope.allow.join(",")} | max_files=${c.scope.max_changed_files} | max_diff_lines=${c.scope.max_diff_lines}`,
          `acceptance: ${c.acceptance.map((a) => a.id).join(", ") || "(none)"}`,
        ].join("\n"),
      );
    } catch (e) {
      return err(`Invalid contract:\n${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "patchbay_delegate",
  {
    title: "Patchbay delegate",
    description: "Start a bounded task in the BACKGROUND: worker in an isolated worktree → policy gate → clean verification. Returns a job_id immediately; poll patchbay_status/patchbay_result until the state is READY_TO_APPLY or a FAILED_* state. The worker cannot apply, commit, push, or merge.",
    inputSchema: contractShape,
    annotations: { title: "Delegate a write task", readOnlyHint: false },
  },
  async ({ contract }, extra) => {
    let vc;
    try {
      vc = validateContract(contract);
    } catch (e) {
      return err(`Invalid contract:\n${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const session = currentSession(extra);
      const j = startJob(vc, session);
      return text(
        [
          `job_id: ${j.id}`,
          `state: ${j.state} (${j.phase})`,
          `worker: ${j.workerProfile}`,
          `base_commit: ${j.baseCommit}`,
          `task_hash: ${j.taskHash}`,
          ``,
          `Started in the background. Poll patchbay_status { "jobId": "${j.id}" } until the state is`,
          `READY_TO_APPLY (then patchbay_result for evidence) or a terminal state.`,
        ].join("\n"),
      );
    } catch (e) {
      const code = e instanceof PipelineError ? e.code : "internal_error";
      return err(`Delegation failed [${code}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "patchbay_status",
  {
    title: "Patchbay status",
    description: "Show a job's state (or list recent jobs).",
    inputSchema: {
      jobId: z.string().optional(),
      allJobs: z.boolean().optional().describe("Include non-owned jobs from other sessions in the repository."),
      limit: z.number().int().positive().max(100).optional().default(20).describe("Maximum number of jobs to return when listing."),
    },
  },
  async ({ jobId, allJobs, limit }, extra) => {
    const session = currentSession(extra);
    if (jobId) {
      const j = getJob(jobId);
      if (!allJobs && j && j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
      return j
        ? text(
            `${j.id}  state=${j.state}  phase=${j.phase}  session=${j.ownerSession}  worker=${j.workerProfile}  base=${j.baseCommit.slice(0, 10)}  created=${j.createdAt}  updated=${j.updatedAt}`,
          )
        : err(`job ${jobId} not found`);
    }
    const jobs = listJobs().filter((j) => allJobs || j.ownerSession === session).slice(0, limit);
    return text(
      jobs.length
        ? jobs.map(
            (j) =>
              `${j.id}  ${j.state}  ${j.phase}  session=${j.ownerSession}  worker=${j.workerProfile}  base=${j.baseCommit.slice(0, 8)}  updated=${j.updatedAt}`,
          ).join("\n")
        : "no jobs",
    );
  },
);

server.registerTool(
  "patchbay_result",
  {
    title: "Patchbay result",
    description: "Load a completed job's verification result and artifact references.",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }, extra) => {
    const session = currentSession(extra);
    const j = getJob(jobId);
    if (!j) return err(`job ${jobId} not found`);
    if (j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
    const policy = readJobArtifact(jobId, "policy.json");
    const verification = readJobArtifact(jobId, "verification.json");
    const lines: string[] = [
      `job_id: ${j.id}`,
      `state: ${j.state}${j.terminalReason ? ` (${j.terminalReason})` : ""}`,
      `task_hash: ${j.taskHash}`,
      j.patchHash ? `patch_hash: ${j.patchHash}` : "patch_hash: (none)",
      `base_commit: ${j.baseCommit}`,
    ];
    if (policy) {
      const p = JSON.parse(policy) as { ok: boolean; violations: { code: string; path?: string }[] };
      lines.push(`policy: ${p.ok ? "ok" : p.violations.map((v) => `${v.code}${v.path ? " " + v.path : ""}`).join(", ")}`);
    }
    if (verification) {
      const v = JSON.parse(verification) as { ok: boolean; reason: string; checks: { id: string; classification: string }[] };
      lines.push(`verification: ${v.ok ? "passed" : "FAILED — " + v.reason}`);
      lines.push(`checks: ${v.checks.map((c) => `${c.id}=${c.classification}`).join(", ") || "(none)"}`);
    }
    lines.push(`artifacts: contract.json, candidate.patch, policy.json, verification.json, receipt.json (under the plugin data dir)`);
    if (j.state === "READY_TO_APPLY") lines.push(`\nVerified. Nothing applied. Use patchbay_prepare_apply then patchbay_apply after user approval.`);
    if (j.state === "STALE") lines.push(`\nSTALE candidate can be re-integrated by calling patchbay_prepare_apply (target base will be refreshed if successful).`);
    const review = readJobArtifact(jobId, "review.json");
    if (review) {
      const r = JSON.parse(review) as { verdict: string; findings?: unknown[]; parseStatus?: string };
      lines.push(`review: ${r.verdict} (${r.parseStatus ?? "ok"})`);
      lines.push(`findings: ${r.findings?.length ?? 0}`);
      const dispositions = readJobArtifact(jobId, "findings-dispositions.json");
      if (dispositions) {
        try {
          const d = JSON.parse(dispositions) as { findingId: string; disposition: string }[];
          lines.push(`dispositions: ${d.length} (${d.map((item) => `${item.findingId}:${item.disposition}`).join(", ")})`);
        } catch {
          // best effort
        }
      }
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "patchbay_prepare_apply",
  {
    title: "Patchbay prepare apply",
    description: "Validate that a verified candidate can be applied to the current checkout (repo identity, HEAD == base, clean tree, matching patch hash). Returns a prepare token.",
    inputSchema: { jobId: z.string(), expectedPatchHash: z.string() },
  },
  async ({ jobId, expectedPatchHash }, extra) => {
    const session = currentSession(extra);
    const j = getJob(jobId);
    if (j && j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
    const plan = prepareApply(jobId, expectedPatchHash);
    return text(
      [
        `ready: ${plan.ready}`,
        `reason: ${plan.reason}`,
        `current_head: ${plan.currentHead ?? "?"}`,
        `expected_base: ${plan.expectedBase}`,
        `changed_files: ${plan.changedFiles.join(", ") || "(none)"}`,
        plan.prepareToken ? `prepare_token: ${plan.prepareToken}` : "",
      ].filter(Boolean).join("\n"),
    );
  },
);

server.registerTool(
  "patchbay_apply",
  {
    title: "Patchbay apply",
    description: "Apply a verified candidate to the active checkout. Consequential — requires user approval. Applies the exact patch to the working tree; does NOT commit, push, merge, or stage.",
    inputSchema: {
      jobId: z.string(),
      expectedTaskHash: z.string(),
      expectedPatchHash: z.string(),
      expectedBase: z.string(),
      prepareToken: z.string(),
    },
    annotations: { title: "Apply verified patch (approval required)", readOnlyHint: false, destructiveHint: true },
  },
  async (args, extra) => {
    const session = currentSession(extra);
    const j = getJob(args.jobId);
    if (j && j.ownerSession !== session) return err(`job ${args.jobId} is not owned by the current session`);
    const res = applyCandidate(args);
    return res.ok ? text(`applied: ${res.appliedFiles} file(s). Not committed. ${res.reason}`) : err(`apply rejected: ${res.reason}`);
  },
);

server.registerTool(
  "patchbay_review",
  {
    title: "Patchbay review",
    description: "Run the read-only Claude reviewer against a verified/review-ready candidate.",
    inputSchema: {
      jobId: z.string(),
      expectedPatchHash: z.string().optional(),
      profile: z.string().optional(),
      modes: z.array(z.enum(["standard", "adversarial", "security", "design"])).optional(),
      timeoutSec: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
    },
  },
  async ({ jobId, expectedPatchHash, profile, modes, timeoutSec, maxOutputBytes }, extra) => {
    const session = currentSession(extra);
    const j = getJob(jobId);
    if (j && j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
    try {
      const review = await runPatchbayReview(jobId, { profile, modes, timeoutSec, maxOutputBytes, expectedPatchHash });
      return text(
        [
          `job_id: ${jobId}`,
          `review_hash: ${review.review.reviewHash}`,
          `verdict: ${review.review.verdict}`,
          `findings: ${review.acceptedCount}`,
          `confirmed: ${review.confirmedFindingIds.length}`,
          `can_create_repair: ${review.canCreateRepair}`,
          review.canCreateRepair ? "Use patchbay_submit_finding_dispositions after validating findings." : "",
        ].filter(Boolean).join("\n"),
      );
    } catch (e) {
      return err(`patchbay_review failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "patchbay_submit_finding_dispositions",
  {
    title: "Patchbay submit finding dispositions",
    description: "Record per-finding Codex dispositions from a completed review.",
    inputSchema: {
      jobId: z.string(),
      reviewHash: z.string(),
      dispositions: z.array(
        z.object({
          id: z.string(),
          disposition: z.enum([
            "confirmed",
            "rejected_false_positive",
            "duplicate",
            "needs_experiment",
            "needs_human_decision",
            "out_of_scope",
          ]),
        }),
      ),
    },
  },
  async ({ jobId, reviewHash, dispositions }, extra) => {
    const session = currentSession(extra);
    const j = getJob(jobId);
    if (j && j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
    const res = submitFindingDispositions({ jobId, reviewHash, dispositions });
    return res.ok ? text(JSON.stringify(res)) : err(JSON.stringify(res));
  },
);

server.registerTool(
  "patchbay_repair",
  {
    title: "Patchbay repair",
    description: "Start a repair child job for confirmed findings.",
    inputSchema: {
      parentJobId: z.string(),
      expectedPatchHash: z.string(),
      expectedReviewHash: z.string(),
      confirmedFindingIds: z.array(z.string()),
      workerProfile: z.string().optional(),
    },
  },
  async ({ parentJobId, expectedPatchHash, expectedReviewHash, confirmedFindingIds, workerProfile }, extra) => {
    const session = currentSession(extra);
    const j = getJob(parentJobId);
    if (j && j.ownerSession !== session) return err(`job ${parentJobId} is not owned by the current session`);
    const res = await startRepairJob({ parentJobId, expectedPatchHash, expectedReviewHash, confirmedFindingIds, workerProfile });
    if (!res.ok) return err(`patchbay_repair failed: ${res.reason}`);
    return text(`repair_job_id: ${res.childJobId}`);
  },
);

server.registerTool(
  "patchbay_receipts",
  {
    title: "Patchbay receipts",
    description: "List recent job receipts, findings, and dispositions.",
    inputSchema: {
      allJobs: z.boolean().optional(),
      includeTerminalOnly: z.boolean().optional(),
      state: z.string().optional(),
      ownerSession: z.string().optional(),
      limit: z.number().int().positive().max(100).optional().default(30),
    },
  },
  async (input, extra) => {
    const session = currentSession(extra);
    const receipts = listReceipts({
      allJobs: input.allJobs,
      includeTerminalOnly: input.includeTerminalOnly,
      state: input.state,
      ownerSession: input.ownerSession ?? session,
      limit: input.limit,
    });
    return text(JSON.stringify(receipts, null, 2));
  },
);

server.registerTool(
  "patchbay_verify",
  {
    title: "Patchbay verify",
    description: "Rerun clean verification for a completed candidate using the stored contract and patch artifacts.",
    inputSchema: { jobId: z.string(), expectedPatchHash: z.string().optional() },
  },
  async ({ jobId, expectedPatchHash }, extra) => {
    const session = currentSession(extra);
    const j = getJob(jobId);
    if (j && j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
    const res = verifyCandidate({ jobId, expectedPatchHash });
    return text(
      JSON.stringify(
        {
          job_id: res.jobId,
          ok: res.ok,
          base_commit: res.baseCommit,
          patch_hash: res.patchHash,
          reason: res.reason,
          checks: res.checks,
          recheck_hash: res.reregisteredHash,
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "patchbay_logs",
  {
    title: "Patchbay logs",
    description: "Read bounded job logs and artifacts for diagnosis.",
    inputSchema: {
      jobId: z.string(),
      includeWorkerLog: z.boolean().optional(),
      includeReview: z.boolean().optional(),
      includePolicy: z.boolean().optional(),
      includeVerification: z.boolean().optional(),
      includeReceipt: z.boolean().optional(),
      includeContract: z.boolean().optional(),
      includePatch: z.boolean().optional(),
      includeEvents: z.boolean().optional(),
      stream: z
        .enum([
          "all",
          "worker",
          "worker_log",
          "worker-log",
          "worker-log.txt",
          "review",
          "policy",
          "verification",
          "receipt",
          "contract",
          "patch",
          "events",
          "event",
        ])
        .optional(),
      cursor: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().positive().optional(),
      maxChars: z.number().int().positive().optional(),
    },
  },
  async ({ jobId, ...options }, extra) => {
    const session = currentSession(extra);
    const j = getJob(jobId);
    if (j && j.ownerSession !== session) return err(`job ${jobId} is not owned by the current session`);
    try {
      const logs = readJobLogs({
        jobId,
        includeWorkerLog: options.includeWorkerLog,
        includeReview: options.includeReview,
        includePolicy: options.includePolicy,
        includeVerification: options.includeVerification,
        includeReceipt: options.includeReceipt,
        includeContract: options.includeContract,
        includePatch: options.includePatch,
        includeEvents: options.includeEvents,
        stream: options.stream,
        cursor: options.cursor,
        maxBytes: options.maxBytes,
        maxChars: options.maxChars,
      });
      return text([
        `job_id: ${logs.jobId}`,
        `truncated: ${logs.truncated}`,
        `next_cursor: ${logs.nextCursor ?? "none"}`,
        `max_bytes: ${logs.limits.maxBytes}`,
        "",
        ...logs.lines,
      ].join("\n"));
    } catch (e) {
      return err(`patchbay_logs failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "patchbay_cancel",
  {
    title: "Patchbay cancel",
    description: "Cancel an owned non-terminal job. Cross-session cancellation requires explicit confirmation.",
    inputSchema: { jobId: z.string(), forceCrossSession: z.boolean().optional().describe("Cancel a non-owned job from another session.") },
  },
  async ({ jobId, forceCrossSession }, extra) => {
    const session = currentSession(extra);
    const res = cancelJob(jobId, session, Boolean(forceCrossSession));
    return res.ok ? text(`job ${jobId}: ${res.reason}`) : err(`job ${jobId}: ${res.reason}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
