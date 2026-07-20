---
name: patchbay:delegate
description: Send a bounded, scoped task to a selected worker (DeepSeek/GLM) and get a verified candidate patch back. Planned for Milestone 1.
---

# $patchbay:delegate

**Status: not yet implemented (Milestone 1).** Backing MCP tool: `patchbay_delegate`.

When implemented, this sends a schema-valid task contract to one worker running in an isolated detached worktree, then extracts and policy-checks the patch and verifies it in a clean worktree. The worker cannot approve, apply, commit, push, or merge.

For now, run `$patchbay:doctor` to confirm a worker profile reads `ready`.
