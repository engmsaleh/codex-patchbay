// Worker runtime interface + a fake runtime for tests/CI (PRD 17.1, 34.2 testkit).
// The real OpenCode/DeepSeek adapter implements this same interface in a later commit.
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Contract } from "./contract.ts";
import { getProfile } from "./profiles.ts";
import { openCodeRuntime } from "./runtime-opencode.ts";

export interface RunInput {
  worktreeDir: string;
  contract: Contract;
}

export interface RawWorkerResult {
  ok: boolean;
  summary: string;
  log: string;
}

export interface WorkerRuntime {
  id: string;
  run(input: RunInput): Promise<RawWorkerResult>;
}

/**
 * Fake runtime. Reads a JSON script from PATCHBAY_FAKE_SCRIPT and applies it to the
 * worktree, letting tests reproduce exact scenarios (scope violations, false pass claims).
 * Script: { writes?: {path,content}[], deletes?: string[], summary?: string, fail?: boolean }
 */
export const fakeRuntime: WorkerRuntime = {
  id: "fake",
  async run({ worktreeDir }: RunInput): Promise<RawWorkerResult> {
    const raw = process.env.PATCHBAY_FAKE_SCRIPT;
    const script = raw ? (JSON.parse(raw) as {
      writes?: { path: string; content: string }[];
      deletes?: string[];
      summary?: string;
      fail?: boolean;
    }) : {};

    if (script.fail) return { ok: false, summary: script.summary ?? "worker failed", log: "fake worker: forced failure" };

    for (const w of script.writes ?? []) {
      const abs = join(worktreeDir, w.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, w.content);
    }
    for (const d of script.deletes ?? []) {
      const abs = join(worktreeDir, d);
      if (existsSync(abs)) rmSync(abs, { force: true });
    }
    return { ok: true, summary: script.summary ?? "applied fake script", log: "fake worker: ok" };
  },
};

/** Resolve a runtime by worker profile: `fake*` → fake; OpenCode profiles → OpenCode adapter. */
export function getRuntime(profile: string): WorkerRuntime {
  if (profile.startsWith("fake")) return fakeRuntime;
  if (getProfile(profile)?.runtime === "opencode") return openCodeRuntime;
  throw new Error(`no worker runtime for profile "${profile}"`);
}
