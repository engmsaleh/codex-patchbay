// Shared child-process runner for worker adapters: own process group, wall-time cap, and
// AbortSignal cancellation. Kills the group of the child we spawned — never a stored PID —
// so PID reuse can't hit an unrelated process (PRD T-07, T-12).
import { spawn } from "node:child_process";

export interface ProcOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface RunProcessOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export function runProcessGroup(bin: string, args: string[], opts: RunProcessOptions): Promise<ProcOutcome> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: opts.env, cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const clip = (buf: string, d: Buffer) => (buf.length < opts.maxBytes ? buf + d.toString() : buf);
    child.stdout.on("data", (d) => (stdout = clip(stdout, d)));
    child.stderr.on("data", (d) => (stderr = clip(stderr, d)));

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* already gone */
        }
      }
    };
    const forceLater = () => setTimeout(() => killGroup("SIGKILL"), 2000);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      forceLater();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killGroup("SIGTERM");
      forceLater();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      cleanup();
      resolve({ code: null, signal: null, stdout, stderr: stderr + `\n${e}`, timedOut, cancelled });
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({ code, signal, stdout, stderr, timedOut, cancelled });
    });
  });
}
