#!/usr/bin/env node
// Fake `claude` binary for review integration tests.
// Usage: fake-claude -p "<prompt>"

const mode = process.env.PATCHBAY_FAKE_CLAUDE_SCRIPT ? JSON.parse(process.env.PATCHBAY_FAKE_CLAUDE_SCRIPT) : {};

if (mode.exitCode !== undefined) process.exit(mode.exitCode);
if (mode.commandFailed) {
  console.error("review command failed intentionally");
  process.exit(1);
}

if (mode.rawOutput !== undefined) {
  process.stdout.write(mode.rawOutput);
  process.exit(0);
}

const output = mode.output ?? {
  verdict: "no_findings",
  findings: [],
  uncertainties: [],
};

process.stdout.write(JSON.stringify(output) + "\n");
process.exit(0);
