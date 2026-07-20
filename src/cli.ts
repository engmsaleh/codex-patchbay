#!/usr/bin/env node
// Patchbay debug/utility CLI. Not the primary surface (that is the Codex plugin + MCP
// server); this exists so `doctor` can be run outside a Codex session for setup/CI.
import { runDoctor, formatDoctor } from "./doctor.ts";
import { PATCHBAY_VERSION } from "./version.ts";

const cmd = process.argv[2];

switch (cmd) {
  case "doctor": {
    const pathFlag = process.argv.indexOf("--path");
    const path = pathFlag !== -1 ? process.argv[pathFlag + 1] : undefined;
    console.log(formatDoctor(runDoctor({ path })));
    break;
  }
  case "--version":
  case "version":
    console.log(PATCHBAY_VERSION);
    break;
  default:
    console.log(`patchbay ${PATCHBAY_VERSION}\n\nUsage:\n  patchbay doctor [--path <repo>]\n  patchbay version`);
    if (cmd && cmd !== "help") process.exitCode = 1;
}
