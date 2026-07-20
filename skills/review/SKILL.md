---
name: patchbay:review
description: Independently review a candidate, branch, commit range, or working-tree diff with Claude Code (read-only, structured findings). Planned for Milestone 2.
---

# $patchbay:review

**Status: not yet implemented (Milestone 2).** Backing MCP tool: `patchbay_review`.

When implemented, Claude reviews a read-only candidate in one of four modes — `standard`, `adversarial`, `security`, `design` — and returns schema-constrained findings. Claude reviews; Codex validates each finding before it becomes a repair requirement. A parse failure is never treated as "no findings".
