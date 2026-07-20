---
name: patchbay:orchestrate
description: Let Codex run the full delegation workflow for a goal — classify risk, write a task contract, pick a worker, verify, and judge. Planned for Milestone 1.
---

# $patchbay:orchestrate <goal>

**Status: not yet implemented (Milestone 1).** The backing MCP tools (`patchbay_estimate`, `patchbay_delegate`, `patchbay_status`, `patchbay_result`) are not built in this Milestone 0 shell.

When implemented, Codex will: inspect the repo and `AGENTS.md`, decide whether the task is delegable, classify risk, compile a typed task contract, select a healthy worker, monitor the job, request review per policy, validate findings, and deliver an evidence-backed judgment. A worker's prose summary is never acceptance evidence.

For now, run `$patchbay:doctor` to confirm readiness.
