import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = mkdtempSync(join(tmpdir(), "patchbay-data-review-"));
process.env.PATCHBAY_DATA_DIR = DATA;

const CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
process.env.PATCHBAY_CLAUDE_BIN = CLAUDE;
const FAKE_SCRIPT = JSON.stringify({
  writes: [{ path: "src/a.ts", content: "export const a = 1;\n" }],
  summary: "review worker",
});

const { validateContract } = await import("../src/contract.ts");
const { runJob, submitFindingDispositions, startRepairJob, listReceipts } = await import("../src/pipeline.ts");
const { getJob } = await import("../src/store.ts");

function sh(cwd: string, ...argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "patchbay-repo-review-"));
  sh(root, "git", "init", "-q");
  sh(root, "git", "config", "user.email", "t@t.dev");
  sh(root, "git", "config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "# repo\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "init");
  return { root, head: sh(root, "git", "rev-parse", "HEAD") };
}

function contract(root: string, head: string, reviewPolicy: "never" | "always" | "on-risk" = "always") {
  return validateContract({
    schema_version: "1.0",
    objective: "review test",
    repository: { root, base_commit: head, dirty_policy: "reject" },
    scope: { allow: ["src/**"] },
    acceptance: [{ id: "pass", argv: ["node", "-e", "process.exit(0)"], required: true }],
    worker: { profile: "fake", selection_reason: "test" },
    metadata: { risk: reviewPolicy === "never" ? "low" : "high" },
    review: { policy: reviewPolicy, profile: "claude-review", modes: ["standard"] },
  });
}

function withEnv<T>(value: object, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PATCHBAY_FAKE_CLAUDE_SCRIPT;
  const priorWorker = process.env.PATCHBAY_FAKE_SCRIPT;
  const payload = (value as { output?: unknown; rawOutput?: string }).output ?? value;
  process.env.PATCHBAY_FAKE_CLAUDE_SCRIPT = JSON.stringify("rawOutput" in (value as Record<string, unknown>) ? value : { output: payload });
  process.env.PATCHBAY_FAKE_SCRIPT = FAKE_SCRIPT;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.PATCHBAY_FAKE_CLAUDE_SCRIPT;
    else process.env.PATCHBAY_FAKE_CLAUDE_SCRIPT = prior;
    if (priorWorker === undefined) delete process.env.PATCHBAY_FAKE_SCRIPT;
    else process.env.PATCHBAY_FAKE_SCRIPT = priorWorker;
  });
}

beforeAll(() => {
  chmodSync(CLAUDE, 0o755);
});

test("review findings transition candidate to CHANGES_REQUESTED", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    {
      verdict: "changes_requested",
      findings: [{ id: "R-001", severity: "high", category: "correctness", file: "src/a.ts", line: 1, claim: "off-by-one", evidence: "unit failed", confidence: 0.9 }],
    },
    () => runJob(contract(root, head), "s"),
  );
  expect(out.job.state).toBe("CHANGES_REQUESTED");
  expect(out.review?.parseStatus).toBe("ok");
  expect(out.review?.findings.length).toBe(1);
});

test("submitting dispositions can de-escalate to READY_TO_APPLY", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    {
      verdict: "changes_requested",
      findings: [{ id: "R-001", severity: "high", category: "correctness", file: "src/a.ts", line: 1, claim: "off-by-one", evidence: "unit failed", confidence: 0.9 }],
    },
    () => runJob(contract(root, head), "s"),
  );
  const j = out.job.id;
  const submit = submitFindingDispositions({
    jobId: j,
    reviewHash: out.review?.reviewHash!,
    dispositions: [{ id: "R-001", disposition: "rejected_false_positive" }],
  });
  expect(submit.ok).toBe(true);
  expect(getJob(j)!.state).toBe("READY_TO_APPLY");
  expect(submit.canCreateRepair).toBe(false);
});

test("confirmed findings can start a repair child and respect repair budget", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    {
      verdict: "changes_requested",
      findings: [{ id: "R-001", severity: "high", category: "correctness", file: "src/a.ts", line: 1, claim: "off-by-one", evidence: "unit failed", confidence: 0.9 }],
    },
    () => runJob(contract(root, head), "s"),
  );
  const j = out.job.id;
  const submit = submitFindingDispositions({
    jobId: j,
    reviewHash: out.review?.reviewHash!,
    dispositions: [{ id: "R-001", disposition: "confirmed" }],
  });
  expect(submit.canCreateRepair).toBe(true);
  expect(submit.confirmedCount).toBe(1);

  const repair = await startRepairJob({
    parentJobId: j,
    expectedPatchHash: out.job.patchHash!,
    expectedReviewHash: out.review?.reviewHash!,
    confirmedFindingIds: ["R-001"],
    workerProfile: "fake",
  });
  expect(repair.ok).toBe(true);
  expect(repair.childJobId).toBeDefined();

  const second = await startRepairJob({
    parentJobId: j,
    expectedPatchHash: out.job.patchHash!,
    expectedReviewHash: out.review?.reviewHash!,
    confirmedFindingIds: ["R-001"],
    workerProfile: "fake",
  });
  expect(second.ok).toBe(false);
  expect(second.reason).toContain("repair budget exceeded");

  const receipts = listReceipts({ ownerSession: "s", includeTerminalOnly: false, limit: 5 });
  expect(receipts.some((r) => r.jobId === j)).toBe(true);
});

test("reviewer output parser ignores noisy non-json and parses trailing json payload", async () => {
  const { root, head } = makeRepo();
  const noisy = "[noop]\n" + JSON.stringify({ notice: "not a payload" }) + "\n" +
    JSON.stringify({
      verdict: "changes_requested",
      findings: [{ id: "R-002", severity: "medium", category: "correctness", claim: "sample", evidence: "repro", confidence: 0.8 }],
    }) + "\n";

  const out = await withEnv(
    { rawOutput: noisy },
    () => runJob(contract(root, head, "always"), "s"),
  );
  expect(out.job.state).toBe("CHANGES_REQUESTED");
  expect(out.review?.parseStatus).toBe("ok");
  expect(out.review?.findings[0]!.id).toBe("R-002");
});
