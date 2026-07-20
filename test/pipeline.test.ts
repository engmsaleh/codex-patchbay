import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate all Patchbay state in a temp dir BEFORE importing modules that resolve paths.
const DATA = mkdtempSync(join(tmpdir(), "patchbay-data-"));
process.env.PATCHBAY_DATA_DIR = DATA;

const { validateContract } = await import("../src/contract.ts");
const { runJob, prepareApply, applyCandidate } = await import("../src/pipeline.ts");
const { getJob } = await import("../src/store.ts");

function sh(cwd: string, ...argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "patchbay-repo-"));
  sh(root, "git", "init", "-q");
  sh(root, "git", "config", "user.email", "t@t.dev");
  sh(root, "git", "config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "# repo\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "init");
  return { root, head: sh(root, "git", "rev-parse", "HEAD") };
}

function baseContract(root: string, head: string, over: Record<string, unknown> = {}) {
  return validateContract({
    schema_version: "1.0",
    objective: "test task",
    repository: { root, base_commit: head, dirty_policy: "reject" },
    scope: { allow: ["src/**"], ...(over.scope as object ?? {}) },
    acceptance: over.acceptance ?? [{ id: "pass", argv: ["node", "-e", "process.exit(0)"], required: true }],
    worker: { profile: "fake", selection_reason: "test" },
  });
}

function withScript<T>(script: object, fn: () => Promise<T>): Promise<T> {
  process.env.PATCHBAY_FAKE_SCRIPT = JSON.stringify(script);
  return fn().finally(() => delete process.env.PATCHBAY_FAKE_SCRIPT);
}

beforeAll(() => {
  // sanity: data dir set
  expect(process.env.PATCHBAY_DATA_DIR).toBe(DATA);
});

test("happy path: allowed change verifies, reaches READY_TO_APPLY, and applies", async () => {
  const { root, head } = makeRepo();
  const vc = baseContract(root, head);
  const out = await withScript({ writes: [{ path: "src/new.ts", content: "export const x = 1;\n" }], summary: "done" }, () =>
    runJob(vc, "session-1"),
  );
  expect(out.job.state).toBe("READY_TO_APPLY");
  expect(out.verification?.ok).toBe(true);
  expect(out.job.patchHash).toBeTruthy();

  // State survives a "restart": read fresh from disk.
  expect(getJob(out.job.id)!.state).toBe("READY_TO_APPLY");

  // Apply is hash-gated: wrong patch hash is rejected.
  const bad = applyCandidate({ jobId: out.job.id, expectedTaskHash: vc.taskHash, expectedPatchHash: "sha256:deadbeef", expectedBase: head, prepareToken: "x" });
  expect(bad.ok).toBe(false);

  // Correct flow: prepare then apply.
  const plan = prepareApply(out.job.id, out.job.patchHash!);
  expect(plan.ready).toBe(true);
  const res = applyCandidate({ jobId: out.job.id, expectedTaskHash: vc.taskHash, expectedPatchHash: out.job.patchHash!, expectedBase: head, prepareToken: plan.prepareToken! });
  expect(res.ok).toBe(true);
  expect(getJob(out.job.id)!.state).toBe("APPLIED");
  expect(existsSync(join(root, "src/new.ts"))).toBe(true);
  // Applied to working tree but NOT committed (PRD P-04, 23.6).
  expect(sh(root, "git", "rev-parse", "HEAD")).toBe(head);
});

test("forbidden path is rejected before verification", async () => {
  const { root, head } = makeRepo();
  const vc = baseContract(root, head, { scope: { allow: ["**"] } }); // broad allow, but deny still wins
  const out = await withScript({ writes: [{ path: ".github/workflows/evil.yml", content: "on: push\n" }] }, () => runJob(vc, "s"));
  expect(out.job.state).toBe("FAILED_POLICY");
  expect(out.policy?.violations.some((v) => v.code === "protected_path")).toBe(true);
  expect(out.verification).toBeUndefined();
});

test("out-of-scope path is rejected", async () => {
  const { root, head } = makeRepo();
  const vc = baseContract(root, head); // allow src/** only
  const out = await withScript({ writes: [{ path: "lib/other.ts", content: "x\n" }] }, () => runJob(vc, "s"));
  expect(out.job.state).toBe("FAILED_POLICY");
  expect(out.policy?.violations.some((v) => v.code === "out_of_scope")).toBe(true);
});

test("false 'tests pass' claim is exposed by clean verification", async () => {
  const { root, head } = makeRepo();
  const vc = baseContract(root, head, { acceptance: [{ id: "fails", argv: ["node", "-e", "process.exit(1)"], required: true }] });
  const out = await withScript({ writes: [{ path: "src/bug.ts", content: "broken\n" }], summary: "all tests pass!" }, () => runJob(vc, "s"));
  expect(out.workerSummary).toContain("pass"); // worker CLAIMED success
  expect(out.job.state).toBe("FAILED_VERIFICATION"); // ...but the verifier disagrees
  expect(out.verification?.ok).toBe(false);
});

test("stale base blocks direct apply", async () => {
  const { root, head } = makeRepo();
  const vc = baseContract(root, head);
  const out = await withScript({ writes: [{ path: "src/a.ts", content: "1\n" }] }, () => runJob(vc, "s"));
  expect(out.job.state).toBe("READY_TO_APPLY");
  // Move HEAD after verification.
  writeFileSync(join(root, "moved.txt"), "x");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "move");
  const plan = prepareApply(out.job.id, out.job.patchHash!);
  expect(plan.ready).toBe(false);
  expect(plan.reason).toContain("stale");
});

test("worker that produces no changes fails", async () => {
  const { root, head } = makeRepo();
  const vc = baseContract(root, head);
  const out = await withScript({ summary: "did nothing" }, () => runJob(vc, "s"));
  expect(out.job.state).toBe("FAILED_WORKER");
});
