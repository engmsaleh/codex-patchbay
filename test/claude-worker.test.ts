import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = mkdtempSync(join(tmpdir(), "patchbay-data-cw-"));
process.env.PATCHBAY_DATA_DIR = DATA;

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude-worker.mjs", import.meta.url));
process.env.PATCHBAY_CLAUDE_WORKER_BIN = FAKE;

const { validateContract } = await import("../src/contract.ts");
const { runJob } = await import("../src/pipeline.ts");
const { authAvailable, getProfile } = await import("../src/profiles.ts");

function sh(cwd: string, ...argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" }).trim();
}
function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "patchbay-repo-cw-"));
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
    worker: { profile: "claude-sonnet", selection_reason: "test" },
    review: { policy: "never", profile: "claude-review", modes: ["standard"] },
    metadata: { risk: "low" },
  });
}
function withScript<T>(script: object, fn: () => Promise<T>): Promise<T> {
  process.env.PATCHBAY_FAKE_CLAUDE_WORKER_SCRIPT = JSON.stringify(script);
  return fn().finally(() => delete process.env.PATCHBAY_FAKE_CLAUDE_WORKER_SCRIPT);
}

beforeAll(() => {
  chmodSync(FAKE, 0o755);
  expect(existsSync(FAKE)).toBe(true);
});

test("claude-sonnet profile is authAvailable when the CLI responds to --version", () => {
  expect(authAvailable(getProfile("claude-sonnet")!)).toBe(true);
});

test("Claude worker edits the worktree and reaches a verified candidate", async () => {
  const { root, head } = makeRepo();
  const out = await withScript({ writes: [{ path: "src/a.ts", content: "export const a=1;\n" }], summary: "created src/a.ts" }, () =>
    runJob(contract(root, head), "s"),
  );
  expect(out.job.state).toBe("READY_TO_APPLY");
  expect(out.verification?.ok).toBe(true);
  expect(out.changes.map((c) => c.path)).toContain("src/a.ts");
  // Edits went into the isolated worktree, NOT the user's real checkout.
  expect(existsSync(join(root, "src/a.ts"))).toBe(false);
});

test("scope violation from the Claude worker is rejected by the policy gate", async () => {
  const { root, head } = makeRepo();
  const out = await withScript({ writes: [{ path: "outside/evil.ts", content: "x\n" }] }, () => runJob(contract(root, head), "s"));
  expect(out.job.state).toBe("FAILED_POLICY");
  expect(out.policy?.violations.some((v) => v.code === "out_of_scope")).toBe(true);
});

test("Claude worker timeout is surfaced as a worker failure", async () => {
  const { root, head } = makeRepo();
  process.env.PATCHBAY_WALL_MS = "600";
  try {
    const out = await withScript({ hang: true }, () => runJob(contract(root, head), "s"));
    expect(out.job.state).toBe("FAILED_WORKER");
  } finally {
    delete process.env.PATCHBAY_WALL_MS;
  }
});
