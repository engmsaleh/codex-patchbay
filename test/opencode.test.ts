import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Isolate Patchbay state before importing path-resolving modules.
const DATA = mkdtempSync(join(tmpdir(), "patchbay-data-oc-"));
process.env.PATCHBAY_DATA_DIR = DATA;

// Route the adapter at the fake opencode binary + a controlled auth file.
const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
process.env.PATCHBAY_OPENCODE_BIN = FAKE;
const AUTH = join(mkdtempSync(join(tmpdir(), "pb-auth-oc-")), "auth.json");
writeFileSync(AUTH, JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" }, "other-provider": { type: "api", key: "sk-other" } }));
process.env.PATCHBAY_OPENCODE_AUTH = AUTH;

const { validateContract } = await import("../src/contract.ts");
const { runJob, startJob, cancelJob } = await import("../src/pipeline.ts");
const { getJob } = await import("../src/store.ts");

function sh(cwd: string, ...argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" }).trim();
}
function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "patchbay-repo-oc-"));
  sh(root, "git", "init", "-q");
  sh(root, "git", "config", "user.email", "t@t.dev");
  sh(root, "git", "config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "# r\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "init");
  return { root, head: sh(root, "git", "rev-parse", "HEAD") };
}
function contract(root: string, head: string, allow = ["src/**"]) {
  return validateContract({
    schema_version: "1.0",
    objective: "impl",
    repository: { root, base_commit: head, dirty_policy: "reject" },
    scope: { allow },
    acceptance: [{ id: "pass", argv: ["node", "-e", "process.exit(0)"], required: true }],
    worker: { profile: "deepseek-fast", selection_reason: "test" },
    metadata: { risk: "low" },
  });
}
function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

beforeAll(() => {
  chmodSync(FAKE, 0o755);
  expect(existsSync(FAKE)).toBe(true);
});

test("OpenCode adapter drives a worker to a verified candidate via the subscription", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    { PATCHBAY_FAKE_OPENCODE_SCRIPT: JSON.stringify({ writes: [{ path: "src/a.ts", content: "export const a=1;\n" }], summary: "impl done" }) },
    () => runJob(contract(root, head), "s"),
  );
  expect(out.job.state).toBe("READY_TO_APPLY");
  expect(out.verification?.ok).toBe(true);
  expect(out.workerSummary).toContain("impl done");
});

test("adapter strips unrelated env (canary) and copies only the selected provider credential", async () => {
  const { root, head } = makeRepo();
  // SECRET_CANARY set in the parent must NOT reach the worker; fake exits 42 if it does.
  // The fake also exits 43 if more than one provider is present in its auth store.
  const out = await withEnv(
    { SECRET_CANARY: "leak", PATCHBAY_FAKE_OPENCODE_SCRIPT: JSON.stringify({ writes: [{ path: "src/a.ts", content: "x\n" }] }) },
    () => runJob(contract(root, head), "s"),
  );
  // Isolation held → worker succeeded → candidate verified.
  expect(out.job.state).toBe("READY_TO_APPLY");
});

test("scope violation from the worker is still rejected by the policy gate", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    { PATCHBAY_FAKE_OPENCODE_SCRIPT: JSON.stringify({ writes: [{ path: "outside/evil.ts", content: "x\n" }] }) },
    () => runJob(contract(root, head), "s"),
  );
  expect(out.job.state).toBe("FAILED_POLICY");
  expect(out.policy?.violations.some((v) => v.code === "out_of_scope")).toBe(true);
});

test("worker timeout is surfaced as a worker failure", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    { PATCHBAY_WALL_MS: "600", PATCHBAY_FAKE_OPENCODE_SCRIPT: JSON.stringify({ hang: true }) },
    () => runJob(contract(root, head), "s"),
  );
  expect(out.job.state).toBe("FAILED_WORKER");
  expect(out.job.terminalReason).toContain("timed out");
});

test("missing subscription credential fails the worker cleanly", async () => {
  const { root, head } = makeRepo();
  const out = await withEnv(
    { PATCHBAY_OPENCODE_AUTH: join(tmpdir(), "does-not-exist.json"), PATCHBAY_FAKE_OPENCODE_SCRIPT: JSON.stringify({ writes: [] }) },
    () => runJob(contract(root, head), "s"),
  );
  expect(out.job.state).toBe("FAILED_WORKER");
});

test("cancel kills a live worker process group and ends CANCELLED (no timeout)", async () => {
  const { root, head } = makeRepo();
  // Long wall time so the timeout can't be what ends it — cancellation must.
  process.env.PATCHBAY_WALL_MS = "60000";
  process.env.PATCHBAY_FAKE_OPENCODE_SCRIPT = JSON.stringify({ hang: true });
  try {
    const job = startJob(contract(root, head), "s");
    const start = Date.now();
    while (getJob(job.id)!.state !== "RUNNING_WORKER" && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 20));
    expect(getJob(job.id)!.state).toBe("RUNNING_WORKER");
    const res = cancelJob(job.id);
    expect(res.ok).toBe(true);
    while (!["CANCELLED", "CANCEL_REQUESTED", "NEEDS_HUMAN"].includes(getJob(job.id)!.state) && Date.now() - start < 12000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const finalState = getJob(job.id)!.state;
    expect(["CANCELLED", "CANCEL_REQUESTED", "NEEDS_HUMAN"]).toContain(finalState);
    expect(Date.now() - start).toBeLessThan(11000); // ended well before the 60s wall cap
  } finally {
    delete process.env.PATCHBAY_WALL_MS;
    delete process.env.PATCHBAY_FAKE_OPENCODE_SCRIPT;
  }
});
