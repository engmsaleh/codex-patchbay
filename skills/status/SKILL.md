---
name: patchbay:status
description: Show a Patchbay job's state, or list recent jobs.
---

# $patchbay:status [job-id]

Backing MCP tool: `patchbay_status`.

- With a `jobId`: shows that job's state, phase, worker, and base commit.
- Without one: lists recent jobs (newest first).

Job state is persisted, so it survives a control-plane restart.
