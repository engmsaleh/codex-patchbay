// Patchbay doctor: reports runtime, provider, sandbox, and repository health.
// Invariant (PRD NFR-002 / FR-006): never emit a credential VALUE. We only ever
// report the env-var NAME and a present/absent boolean.
import { spawnSync } from "node:child_process";
import { PATCHBAY_VERSION } from "./version.ts";
import { getProfile, authAvailable } from "./profiles.ts";

export type Health = "ready" | "degraded" | "blocked" | "unknown";

export interface Component {
  name: string;
  status: Health;
  detail: string;
}

export interface DoctorReport {
  version: string;
  /** "fake" when no provider credential is present — doctor still answers fully. */
  mode: "fake" | "live";
  components: Component[];
  availableWorkflows: string[];
  unavailable: string[];
}

// Worker families → a representative profile whose auth we probe. Auth is the OpenCode Go
// subscription (credential in OpenCode's store), so readiness = OpenCode present + authed.
const WORKER_FAMILIES = [
  { label: "DeepSeek profile", profile: "deepseek-fast", workflow: "DeepSeek implementation" },
  { label: "GLM Coding Plan profile", profile: "glm-fast", workflow: "GLM implementation" },
] as const;

const REVIEWER = { label: "Claude Code reviewer", bin: "claude", workflow: "Claude review" } as const;

/** Run a command directly (no shell, argv array — PRD AD-09) and capture stdout. */
function tryCmd(argv: string[], timeoutMs = 4000): { ok: boolean; out: string } {
  try {
    const r = spawnSync(argv[0], argv.slice(1), { timeout: timeoutMs, encoding: "utf8", shell: false });
    if (r.error || r.status !== 0) return { ok: false, out: (r.stderr || r.stdout || "").trim() };
    return { ok: true, out: (r.stdout || "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}

export interface DoctorOptions {
  /** Repository path to inspect; defaults to cwd. */
  path?: string;
  /** Injectable env for testing; defaults to process.env checks via credPresent. */
}

export function runDoctor(opts: DoctorOptions = {}): DoctorReport {
  const cwd = opts.path ?? process.cwd();
  const components: Component[] = [];
  const available: string[] = [];
  const unavailable: string[] = [];

  // Runtime host.
  components.push({
    name: "Node.js runtime",
    status: "ready",
    detail: process.version,
  });

  // Git.
  const git = tryCmd(["git", "--version"]);
  components.push({
    name: "Git",
    status: git.ok ? "ready" : "blocked",
    detail: git.ok ? firstLine(git.out).replace(/^git version /, "") : "not found on PATH",
  });

  // OpenCode (cheap-worker harness).
  const opencode = tryCmd(["opencode", "--version"]);
  components.push({
    name: "OpenCode",
    status: opencode.ok ? "ready" : "blocked",
    detail: opencode.ok ? firstLine(opencode.out) : "not found on PATH",
  });

  // Container sandbox (optional in v0.1; secure mode arrives in v1.0).
  const docker = tryCmd(["docker", "--version"]);
  components.push({
    name: "Container sandbox",
    status: docker.ok ? "ready" : "degraded",
    detail: docker.ok ? firstLine(docker.out) : "no Docker-compatible engine (standard isolation only)",
  });

  // Worker families: ready iff OpenCode present AND the subscription is authenticated.
  let anyCred = false;
  for (const w of WORKER_FAMILIES) {
    const profile = getProfile(w.profile)!;
    const hasCred = authAvailable(profile);
    anyCred ||= hasCred;
    let status: Health;
    let detail: string;
    if (!opencode.ok) {
      status = "blocked";
      detail = "runtime opencode unavailable";
    } else if (!hasCred) {
      status = "degraded";
      detail = "OpenCode Go subscription not authenticated (run: opencode auth login)";
    } else {
      status = "ready";
      detail = "OpenCode Go subscription authenticated";
    }
    components.push({ name: w.label, status, detail });
    (status === "ready" ? available : unavailable).push(w.workflow);
  }

  // Claude reviewer: ready iff the binary exists. Actual auth is verified at job time
  // (subscription or ANTHROPIC_API_KEY) so we do not assert a credential here.
  const claude = tryCmd([REVIEWER.bin, "--version"]);
  components.push({
    name: REVIEWER.label,
    status: claude.ok ? "ready" : "degraded",
    detail: claude.ok ? firstLine(claude.out) : "claude CLI not found on PATH",
  });
  (claude.ok ? available : unavailable).push(REVIEWER.workflow);

  // Repository state.
  const inRepo = tryCmd(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  if (git.ok && inRepo.ok && inRepo.out === "true") {
    const head = tryCmd(["git", "-C", cwd, "rev-parse", "--short", "HEAD"]);
    const status = tryCmd(["git", "-C", cwd, "status", "--porcelain"]);
    const clean = status.ok && status.out.length === 0;
    const headSha = head.ok ? head.out : "unborn";
    components.push({
      name: "Repository",
      status: "ready",
      detail: `${clean ? "clean" : "dirty"} HEAD ${headSha}`,
    });
  } else {
    components.push({
      name: "Repository",
      status: "degraded",
      detail: "not a Git work tree (run inside a repository to delegate)",
    });
  }

  return {
    version: PATCHBAY_VERSION,
    mode: anyCred ? "live" : "fake",
    components,
    availableWorkflows: available,
    unavailable,
  };
}

/** Human-readable rendering (PRD 11.2). Pure — no secrets, safe to log or return over MCP. */
export function formatDoctor(report: DoctorReport): string {
  const pad = (s: string) => s.padEnd(26, " ");
  const lines: string[] = [];
  lines.push(`Patchbay doctor  (v${report.version}, ${report.mode} mode)`);
  lines.push("");
  for (const c of report.components) {
    const label = c.status === "ready" ? "ready" : `${c.status}: ${c.detail}`;
    const detail = c.status === "ready" && c.detail ? `${c.status}, ${c.detail}` : label;
    lines.push(`${pad(c.name)}${detail}`);
  }
  lines.push("");
  lines.push(`Available workflows: ${report.availableWorkflows.join(", ") || "none"}`);
  if (report.unavailable.length) lines.push(`Unavailable: ${report.unavailable.join(", ")}`);
  return lines.join("\n");
}
