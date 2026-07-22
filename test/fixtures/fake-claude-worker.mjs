#!/usr/bin/env node
// Fake `claude` worker binary for adapter conformance tests (no real subscription).
// The adapter runs it with cwd = the worktree, so writes target process.cwd().
// Driven by PATCHBAY_FAKE_CLAUDE_WORKER_SCRIPT (JSON).
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("claude-fake 0.0.0 (worker)");
  process.exit(0);
}

const script = process.env.PATCHBAY_FAKE_CLAUDE_WORKER_SCRIPT ? JSON.parse(process.env.PATCHBAY_FAKE_CLAUDE_WORKER_SCRIPT) : {};

if (script.hang) {
  setInterval(() => {}, 1 << 30); // wait to be killed (timeout/cancel test)
} else {
  const dir = process.cwd(); // adapter sets cwd = worktree
  for (const w of script.writes ?? []) {
    const abs = join(dir, w.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, w.content);
  }
  for (const d of script.deletes ?? []) {
    const abs = join(dir, d);
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
  console.log(script.summary ?? "edited files");
  process.exit(script.exit ?? 0);
}
