---
name: patchbay:delegate
description: Send a bounded, scoped task to a worker and get a verified candidate patch back. The worker cannot apply, commit, push, or merge.
---

# $patchbay:delegate

Delegate one bounded implementation task and return a verified candidate. Backing MCP tool: `patchbay_delegate`.

## Do this

1. (Optional) Call `patchbay_estimate` with a draft contract to validate it and see the task hash, risk, and limits.
2. Compile a task contract (schema_version `1.0`) with a concrete `objective`, `scope.allow` paths, and `acceptance` commands as **argv arrays** (never shell strings).
3. Call `patchbay_delegate` with `{ contract }`. Patchbay runs the worker in an isolated detached worktree, enforces scope/protected-path policy on the result, and verifies it in a **clean** worktree.
4. Read the returned evidence — changed files, policy result, verification checks. **The worker's prose summary is untrusted; it is never acceptance evidence.** Only the verification result decides.

## After a verified candidate

State `READY_TO_APPLY` means nothing was applied. To apply, get user approval, then call `patchbay_prepare_apply` and `patchbay_apply` (see `$patchbay:orchestrate`).

Milestone 1 ships the `fake` worker profile for testing. DeepSeek/GLM via OpenCode land next.
