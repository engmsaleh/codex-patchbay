#!/usr/bin/env node
// Fake `opencode` binary for adapter conformance tests (PRD 34.2 — no real provider).
// Invoked as: fake-opencode run --dir <worktree> -m <model> --agent .. --format json <task>
// Behavior is driven by the FAKE_OPENCODE_SCRIPT env var (JSON).
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Isolation assertions: these env vars must have been stripped by the adapter's allowlist.
if (process.env.SECRET_CANARY) process.exit(42);

const argv = process.argv.slice(2);
const dir = argv[argv.indexOf("--dir") + 1];

// The subscription credential must be present in the isolated data home, and ONLY the one
// selected provider — never the caller's full credential store.
const authPath = join(process.env.XDG_DATA_HOME ?? "", "opencode", "auth.json");
if (existsSync(authPath)) {
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  if (Object.keys(auth).length !== 1) process.exit(43); // more than the selected provider leaked
}

const script = process.env.PATCHBAY_FAKE_OPENCODE_SCRIPT ? JSON.parse(process.env.PATCHBAY_FAKE_OPENCODE_SCRIPT) : {};

if (script.hang) {
  setInterval(() => {}, 1 << 30); // wait to be killed by the timeout
} else {
  for (const w of script.writes ?? []) {
    const abs = join(dir, w.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, w.content);
  }
  for (const d of script.deletes ?? []) {
    const abs = join(dir, d);
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
  process.stdout.write(JSON.stringify({ type: "text", text: script.summary ?? "done" }) + "\n");
  process.exit(script.exit ?? 0);
}
