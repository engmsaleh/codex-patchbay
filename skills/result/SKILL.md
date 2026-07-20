---
name: patchbay:result
description: Load a completed job's verification result, patch hash, and artifact references.
---

# $patchbay:result <job-id>

Backing MCP tool: `patchbay_result`.

Returns the job state, task hash, patch hash, base commit, and the on-disk artifact set (`contract.json`, `candidate.patch`, `policy.json`, `verification.json`, `receipt.json`) stored under the plugin data directory. Every artifact is content-hashed.
