---
name: patchbay:cancel
description: Cancel a non-terminal job.
---

# $patchbay:cancel <job-id>

Backing MCP tool: `patchbay_cancel`. Transitions a non-terminal job to `CANCELLED`.

**Milestone 1 limitation:** jobs run synchronously through the fake worker, so there is no live process to terminate here. Cooperative process-tree termination of a running worker (grace period → force kill, by process identity not PID) lands with the async OpenCode adapter (PRD 10.5, 31.3).
