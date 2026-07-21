import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRecord } from "../src/store.ts";

const DATA = mkdtempSync(join(tmpdir(), "patchbay-data-async-"));
process.env.PATCHBAY_DATA_DIR = DATA;

const { validateContract } = await import("../src/contract.ts");
const { startJob, cancelJob, runJob } = await import("../src/pipeline.ts");
const { getJob } = await import("../src/store.ts");

function sh(cwd: string, ...argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" }).trim();
}
function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "patchbay-repo-async-"));
  sh(root, "git", "init", "-q");
  sh(root, "git", "config", "user.email", "t@t.dev");
  sh(root, "git", "config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "# r\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "init");
  return { root, head: sh(root, "git", "rev-parse", "HEAD") };
}
function contract(root: string, head: string) {
  return validateContract({
    schema_version: "1.0",
    objective: "impl",
    repository: { root, base_commit: head, dirty_policy: "reject" },
    scope: { allow: ["src/**"] },
    acceptance: [{ id: "pass", argv: ["node", "-e", "process.exit(0)"], required: true }],
    worker: { profile: "fake", selection_reason: "test" },
    metadata: { risk: "low" },
  });
}
async function waitFor(jobId: string, pred: (j: JobRecord) => boolean, ms = 8000): Promise<JobRecord> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const j = getJob(jobId);
    if (j && pred(j)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout; state=${getJob(jobId)?.state}`);
}

test("startJob returns immediately, then the job progresses to READY_TO_APPLY in the background", async () => {
  const { root, head } = makeRepo();
  process.env.PATCHBAY_FAKE_SCRIPT = JSON.stringify({ writes: [{ path: "src/a.ts", content: "export const a=1;\n" }] });
  try {
    const job = startJob(contract(root, head), "s");
    // Returned before the pipeline finished.
    expect(["CREATED", "VALIDATED", "WORKTREE_READY", "RUNNING_WORKER"]).toContain(job.state);
    const done = await waitFor(job.id, (j) => j.state === "READY_TO_APPLY");
    expect(done.patchHash).toBeTruthy();
  } finally {
    delete process.env.PATCHBAY_FAKE_SCRIPT;
  }
});

test("cancelJob aborts a running worker and the job ends CANCELLED", async () => {
  const { root, head } = makeRepo();
  process.env.PATCHBAY_FAKE_SCRIPT = JSON.stringify({ delayMs: 4000, writes: [{ path: "src/a.ts", content: "1\n" }] });
  try {
    const job = startJob(contract(root, head), "s");
    await waitFor(job.id, (j) => j.state === "RUNNING_WORKER");
    const res = cancelJob(job.id);
    expect(res.ok).toBe(true);
    const done = await waitFor(job.id, (j) => j.state === "CANCELLED");
    expect(done.state).toBe("CANCELLED");
  } finally {
    delete process.env.PATCHBAY_FAKE_SCRIPT;
  }
});

test("cancelJob enforces owner session unless forceCrossSession is set", async () => {
  const { root, head } = makeRepo();
  process.env.PATCHBAY_FAKE_SCRIPT = JSON.stringify({ delayMs: 4000, writes: [{ path: "src/a.ts", content: "1\n" }] });
  try {
    const job = startJob(contract(root, head), "owner-session");
    await waitFor(job.id, (j) => j.state === "RUNNING_WORKER");

    const denied = cancelJob(job.id, "other-session");
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("different session");

    const forced = cancelJob(job.id, "other-session", true);
    expect(forced.ok).toBe(true);

    const done = await waitFor(job.id, (j) => j.state === "CANCELLED");
    expect(done.state).toBe("CANCELLED");
  } finally {
    delete process.env.PATCHBAY_FAKE_SCRIPT;
  }
});

test("cancelJob transitions non-running nonterminal jobs to CANCELLED", async () => {
  const { root, head } = makeRepo();
  process.env.PATCHBAY_FAKE_SCRIPT = JSON.stringify({ writes: [{ path: "src/a.ts", content: "1\n" }] });
  try {
    const job = startJob(contract(root, head), "s");
    const ready = await waitFor(job.id, (j) => j.state === "READY_TO_APPLY");
    expect(ready.state).toBe("READY_TO_APPLY");

    const res = cancelJob(ready.id, "s");
    expect(res.ok).toBe(true);
    const done = await waitFor(job.id, (j) => j.state === "CANCELLED");
    expect(done.state).toBe("CANCELLED");
  } finally {
    delete process.env.PATCHBAY_FAKE_SCRIPT;
  }
});

test("cancelling a terminal job is rejected", async () => {
  const { root, head } = makeRepo();
  // Out-of-scope write → FAILED_POLICY (a terminal state).
  process.env.PATCHBAY_FAKE_SCRIPT = JSON.stringify({ writes: [{ path: "outside/x.ts", content: "1\n" }] });
  let jobId: string;
  try {
    const out = await runJob(contract(root, head), "s");
    jobId = out.job.id;
    expect(out.job.state).toBe("FAILED_POLICY");
  } finally {
    delete process.env.PATCHBAY_FAKE_SCRIPT;
  }
  const res = cancelJob(jobId);
  expect(res.ok).toBe(false);
  expect(res.reason).toContain("terminal");
});
