---
name: patchbay:doctor
description: Check Patchbay readiness — runtimes, worker/reviewer profiles, sandbox, and repository state. Use before delegating or reviewing.
---

# $patchbay:doctor

Report health and compatibility without revealing any credential value.

## Do this

1. Call the `patchbay_doctor` MCP tool (pass `path` if the target repository is not the current working directory).
2. Present the returned report verbatim. It lists each component as `ready`, `degraded`, or `blocked`, followed by available and unavailable workflows.

## Read the result as

- **ready** — usable now.
- **degraded** — usable with a caveat (e.g. a worker with no credential, or no container sandbox → standard isolation only).
- **blocked** — a required runtime is missing; that workflow cannot run.

Do not proceed with delegation for a worker whose profile is not `ready`. Report the exact missing piece (a runtime binary or a named credential env var) so the user can fix it.
