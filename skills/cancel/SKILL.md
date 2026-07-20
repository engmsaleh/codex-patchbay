---
name: patchbay:cancel
description: Cancel an owned active job, terminating its exact process tree and preserving partial artifacts. Planned for Milestone 1.
---

# $patchbay:cancel <job-id>

**Status: not yet implemented (Milestone 1).** Backing MCP tool: `patchbay_cancel`.

When implemented, verifies job ownership, transitions the job atomically, terminates the exact process tree by process identity (not PID alone), preserves partial artifacts, and cleans or quarantines the worktree. Cross-session cancellation requires explicit confirmation.
