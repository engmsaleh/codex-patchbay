// OpenCode worker adapter (PRD 17.2, AD-03). Drives `opencode run` non-interactively in
// the isolated worktree with a deny-first config and a stripped environment.
//
// SECURITY MODEL: the real enforcement is Patchbay's — detached worktree, env allowlist,
// temp HOME, and the post-run policy gate + clean verifier. OpenCode's own permissions are
// defense-in-depth (P-09: prompts guide, software enforces).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkerRuntime, RunInput, RawWorkerResult } from "./runtime.ts";
import type { Contract } from "./contract.ts";
import { getProfile, resolveModel, opencodeAuthPath, type WorkerProfile } from "./profiles.ts";

/** Injectable so tests can run against a fake opencode binary (PRD 34.2, no real provider). */
function openCodeBin(): string {
  return process.env.PATCHBAY_OPENCODE_BIN ?? "opencode";
}

// Deny-first OpenCode config: no bash, no network, no sub-agents. Written under a temp
// HOME so it never lands in the worktree (which would pollute the candidate patch).
function denyFirstConfig(): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "allow", bash: "deny", webfetch: "deny" },
    agent: {
      "patchbay-worker": {
        description: "Bounded Patchbay implementation worker.",
        mode: "primary",
        tools: { task: false, webfetch: false, bash: false },
      },
    },
  });
}

/** Strict env allowlist: PATH-like vars, an isolated HOME/XDG, and (env-mode) the API key. */
function workerEnv(profile: WorkerProfile, tempHome: string): NodeJS.ProcessEnv {
  const credEnv = profile.auth.mode === "provider_env" ? profile.auth.envAllow : [];
  const allow = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", ...credEnv]);
  const env: NodeJS.ProcessEnv = {
    HOME: tempHome,
    XDG_CONFIG_HOME: join(tempHome, ".config"),
    XDG_DATA_HOME: join(tempHome, ".local", "share"),
  };
  for (const k of allow) {
    const v = process.env[k];
    if (v != null) env[k] = v;
  }
  // Test seam: only when a fake opencode binary is injected, forward PATCHBAY_FAKE_* so
  // fixtures can be scripted. Never active with the real opencode binary.
  if (process.env.PATCHBAY_OPENCODE_BIN) {
    for (const k of Object.keys(process.env)) if (k.startsWith("PATCHBAY_FAKE_")) env[k] = process.env[k];
  }
  return env;
}

/**
 * Provision the worker's credential inside the isolated home. For the OpenCode Go
 * subscription we copy ONLY the selected provider's auth entry — not the user's whole
 * credential store (PRD 16.9 credential minimization). Env-mode needs no file.
 */
function setupAuth(profile: WorkerProfile, tempHome: string): void {
  if (profile.auth.mode !== "opencode_subscription") return;
  const path = opencodeAuthPath();
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`OpenCode credential store not found at ${path}; run: opencode auth login`);
  }
  const entry = all[profile.auth.provider];
  if (!entry) throw new Error(`OpenCode credential for provider "${profile.auth.provider}" not found; run: opencode auth login`);
  const dir = join(tempHome, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ [profile.auth.provider]: entry }), { mode: 0o600 });
}

function compileTask(contract: Contract): string {
  const lines = [
    `# Task`,
    contract.objective,
    ``,
    `## Non-goals`,
    ...(contract.non_goals.length ? contract.non_goals.map((g) => `- ${g}`) : ["- (none)"]),
    ``,
    `## Allowed paths (edit ONLY these)`,
    ...contract.scope.allow.map((p) => `- ${p}`),
    ``,
    `## Forbidden`,
    `- Do not edit anything outside the allowed paths.`,
    `- Do not run git commit/push or access the network.`,
    ``,
    `## Acceptance (verified independently — make these pass)`,
    ...(contract.acceptance.length ? contract.acceptance.map((a) => `- ${a.id}: ${a.argv.join(" ")}`) : ["- (none specified)"]),
  ];
  return lines.join("\n");
}

interface ProcOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxBytes: number): Promise<ProcOutcome> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const clip = (buf: string, d: Buffer) => (buf.length < maxBytes ? buf + d.toString() : buf);
    child.stdout.on("data", (d) => (stdout = clip(stdout, d)));
    child.stderr.on("data", (d) => (stderr = clip(stderr, d)));

    // Kill the whole process group on timeout (SIGTERM grace, then SIGKILL) — PRD T-07/T-12.
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000);
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: stderr + `\n${e}`, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** Best-effort usage/summary extraction from `--format json` event lines. */
function summarize(stdout: string): string {
  let summary = "";
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as { type?: string; text?: string; part?: { text?: string } };
      const text = ev.text ?? ev.part?.text;
      if (typeof text === "string" && text.trim()) summary = text.trim().slice(0, 500);
    } catch {
      /* ignore non-JSON log lines */
    }
  }
  return summary || "opencode run completed";
}

export const openCodeRuntime: WorkerRuntime = {
  id: "opencode",
  async run({ worktreeDir, contract }: RunInput): Promise<RawWorkerResult> {
    const profile = getProfile(contract.worker.profile);
    if (!profile) return { ok: false, summary: "", log: `unknown profile ${contract.worker.profile}` };

    const model = resolveModel(profile); // full "provider/model", e.g. opencode-go/deepseek-v4-flash
    const tempHome = mkdtempSync(join(tmpdir(), "patchbay-home-"));
    try {
      const cfgDir = join(tempHome, ".config", "opencode");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "opencode.json"), denyFirstConfig());
      setupAuth(profile, tempHome);

      const args = ["run", "--dir", worktreeDir, "-m", model, "--agent", "patchbay-worker", "--format", "json", compileTask(contract)];
      const env = workerEnv(profile, tempHome);
      // PATCHBAY_WALL_MS overrides the wall-time cap (used by tests to force a fast timeout).
      const wallMs = Number(process.env.PATCHBAY_WALL_MS) || profile.limits.maxWallSeconds * 1000;
      const outcome = await runProcess(openCodeBin(), args, env, wallMs, profile.limits.maxOutputBytes);

      const log = `# opencode ${model}\nexit=${outcome.code} signal=${outcome.signal} timedOut=${outcome.timedOut}\n\n[stdout]\n${outcome.stdout}\n\n[stderr]\n${outcome.stderr}`;
      if (outcome.timedOut) return { ok: false, summary: "worker timed out", log };
      if (outcome.code !== 0) return { ok: false, summary: `opencode exited ${outcome.code}`, log };
      return { ok: true, summary: summarize(outcome.stdout), log };
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  },
};
