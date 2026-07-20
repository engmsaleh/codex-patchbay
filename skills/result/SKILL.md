---
name: patchbay:result
description: Load a completed job's candidate summary, diff metadata, and verification result. Planned for Milestone 1.
---

# $patchbay:result <job-id>

**Status: not yet implemented (Milestone 1).** Backing MCP tool: `patchbay_result`.

When implemented, returns the candidate summary, changed files, patch metadata, policy result, verification result, review result, and artifact references. Large raw patches are fetched by bounded artifact access, not dumped into context.
