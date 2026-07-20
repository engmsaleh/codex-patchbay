// Patchbay MCP server (STDIO). Milestone 1: doctor + the delegation/verify/apply tools
// backed by the local control plane. Tool names use the stable `patchbay_` prefix (PRD 20).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDoctor, formatDoctor } from "../doctor.ts";
import { PATCHBAY_VERSION } from "../version.ts";
import { validateContract } from "../contract.ts";
import { runJob, prepareApply, applyCandidate, PipelineError } from "../pipeline.ts";
import { getJob, listJobs, transition, TERMINAL } from "../store.ts";

const server = new McpServer({ name: "patchbay", version: PATCHBAY_VERSION });

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string): Text => ({ content: [{ type: "text", text: s }] });
const err = (s: string): Text => ({ content: [{ type: "text", text: s }], isError: true });

const contractShape = { contract: z.record(z.string(), z.unknown()).describe("A Patchbay task contract (schema_version 1.0).") };

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
    description: "Run a bounded task: worker in an isolated worktree → policy gate → clean verification. Returns a verified candidate that still requires approval to apply. The worker cannot apply, commit, push, or merge.",
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
      const session = (extra?.sessionId as string | undefined) ?? "codex";
      const out = await runJob(vc, session);
      const j = out.job;
      const lines = [
        `job_id: ${j.id}`,
        `state: ${j.state}${j.terminalReason ? ` (${j.terminalReason})` : ""}`,
        `base_commit: ${j.baseCommit}`,
        `task_hash: ${j.taskHash}`,
        j.patchHash ? `patch_hash: ${j.patchHash}` : "",
        `changed_files: ${out.changes.map((c) => `${c.path} (${c.type}, ${c.churn})`).join("; ") || "(none)"}`,
        out.policy ? `policy: ${out.policy.ok ? "ok" : out.policy.violations.map((v) => `${v.code}${v.path ? " " + v.path : ""}`).join(", ")}` : "",
        out.verification ? `verification: ${out.verification.ok ? "passed" : "FAILED — " + out.verification.reason}` : "",
        out.verification ? `checks: ${out.verification.checks.map((c) => `${c.id}=${c.classification}`).join(", ") || "(none)"}` : "",
        `worker_summary (untrusted): ${out.workerSummary}`,
      ].filter(Boolean);
      if (j.state === "READY_TO_APPLY") lines.push(`\nVerified. Nothing applied. Use patchbay_prepare_apply then patchbay_apply after user approval.`);
      return text(lines.join("\n"));
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
    inputSchema: { jobId: z.string().optional() },
  },
  async ({ jobId }) => {
    if (jobId) {
      const j = getJob(jobId);
      return j ? text(`${j.id}  ${j.state}  phase=${j.phase}  worker=${j.workerProfile}  base=${j.baseCommit.slice(0, 10)}`) : err(`job ${jobId} not found`);
    }
    const jobs = listJobs().slice(0, 20);
    return text(jobs.length ? jobs.map((j) => `${j.id}  ${j.state}  ${j.workerProfile}  ${j.updatedAt}`).join("\n") : "no jobs");
  },
);

server.registerTool(
  "patchbay_result",
  {
    title: "Patchbay result",
    description: "Load a completed job's verification result and artifact references.",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => {
    const j = getJob(jobId);
    if (!j) return err(`job ${jobId} not found`);
    return text(
      [
        `job_id: ${j.id}`,
        `state: ${j.state}${j.terminalReason ? ` (${j.terminalReason})` : ""}`,
        `task_hash: ${j.taskHash}`,
        j.patchHash ? `patch_hash: ${j.patchHash}` : "patch_hash: (none)",
        `base_commit: ${j.baseCommit}`,
        `artifacts: contract.json, candidate.patch, policy.json, verification.json, receipt.json (under the plugin data dir)`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "patchbay_prepare_apply",
  {
    title: "Patchbay prepare apply",
    description: "Validate that a verified candidate can be applied to the current checkout (repo identity, HEAD == base, clean tree, matching patch hash). Returns a prepare token.",
    inputSchema: { jobId: z.string(), expectedPatchHash: z.string() },
  },
  async ({ jobId, expectedPatchHash }) => {
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
  async (args) => {
    const res = applyCandidate(args);
    return res.ok ? text(`applied: ${res.appliedFiles} file(s). Not committed. ${res.reason}`) : err(`apply rejected: ${res.reason}`);
  },
);

server.registerTool(
  "patchbay_cancel",
  {
    title: "Patchbay cancel",
    description: "Cancel a non-terminal job.",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => {
    const j = getJob(jobId);
    if (!j) return err(`job ${jobId} not found`);
    if (TERMINAL.has(j.state)) return err(`job ${jobId} is already terminal (${j.state})`);
    // ponytail: M1 jobs run synchronously through the fake runtime, so there is no live
    // process to kill here. Cooperative process-tree termination lands with the async
    // OpenCode worker adapter (PRD 10.5, 31.3).
    try {
      transition(jobId, j.state, "CANCELLED", "cancelled", { terminalReason: "cancelled by request" });
      return text(`job ${jobId} cancelled`);
    } catch (e) {
      return err(`cannot cancel from state ${j.state}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
