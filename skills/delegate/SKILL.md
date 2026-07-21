---
name: patchbay:delegate
description: Send a bounded, scoped task to a worker and get a verified candidate patch back. The worker cannot apply, commit, push, or merge.
---

# $patchbay:delegate

Delegate one bounded implementation task and return a verified candidate. Backing MCP tool: `patchbay_delegate`.

## Do this

1. (Optional) Call `patchbay_estimate` with a draft contract to validate it and see the task hash, risk, and limits.
2. Compile a task contract (schema_version `1.0`) with a concrete `objective`, `scope.allow` paths, and `acceptance` commands as **argv arrays** (never shell strings).
3. Call `patchbay_delegate` with `{ contract }`. It returns a **job_id immediately** and runs the worker in the background (isolated detached worktree → scope/protected-path policy → clean-worktree verification).
4. Poll `patchbay_status { jobId }` until the state is `READY_TO_APPLY` or a `FAILED_*` / `CANCELLED` state. Then call `patchbay_result { jobId }` for the evidence — changed files, policy result, verification checks. **The worker's prose summary is untrusted; it is never acceptance evidence.** If the job is `STALE`, call `patchbay_prepare_apply` to attempt re-integration and produce a fresh approval token. Use `patchbay_verify` for manual re-runs and `patchbay_logs` when you need bounded chunks of logs or artifacts. Use `patchbay_cancel { jobId }` to stop a running worker.

## After a verified candidate

State `READY_TO_APPLY` means nothing was applied. To apply, get user approval, then call `patchbay_prepare_apply` and `patchbay_apply` (see `$patchbay:orchestrate`).

Worker profiles: `deepseek-fast`, `deepseek-capable`, `glm-fast`, `glm-capable` (DeepSeek/GLM via OpenCode Go), plus `fake` for testing. Auth uses your OpenCode Go subscription — run `opencode auth login` if `$patchbay:doctor` shows them degraded.
