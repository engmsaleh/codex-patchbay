---
name: patchbay:cancel
description: Cancel a running or queued job — aborts the live worker and terminates its process tree.
---

# $patchbay:cancel <job-id>

Backing MCP tool: `patchbay_cancel`.

- If the worker is still running, it aborts the worker and kills its process group (SIGTERM
  grace → SIGKILL), then the job ends `CANCELLED`. Partial artifacts are preserved.
- If the job is past the worker phase (finishing fast policy/verification), it is allowed to
  complete rather than discarding a verified result.
- A job that is already terminal cannot be cancelled.

Cancellation kills the exact child process Patchbay spawned — never a stored PID — so PID
reuse can't affect an unrelated process.
