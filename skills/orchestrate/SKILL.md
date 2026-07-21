---
name: patchbay:orchestrate
description: Let Codex run the full delegation workflow for a goal — classify risk, write a task contract, delegate, verify, judge, and gate application on approval.
---

# $patchbay:orchestrate <goal>

Run the end-to-end workflow. Codex stays the orchestrator and final judge.

## Do this

1. Inspect the repo and any `AGENTS.md` rules. Decide whether the goal is delegable and classify its risk.
2. Compile a typed task contract: concrete `objective`, `non_goals`, tight `scope.allow`, and `acceptance` argv commands. Validate it with `patchbay_estimate`.
3. Call `patchbay_delegate` — it returns a job_id immediately and runs in the background. Poll `patchbay_status { jobId }` until `READY_TO_APPLY` or a terminal failure, then `patchbay_result { jobId }`. If the job is `STALE`, call `patchbay_prepare_apply` to re-integrate and get a fresh plan. Inspect the returned **evidence** (policy + clean verification), not the worker's prose. Use `patchbay_verify` to re-run deterministic verification on demand, and `patchbay_logs { stream: \"verification\" }` / `patchbay_logs` for bounded artifact slices. Cancel a runaway job with `patchbay_cancel`.
4. Report an evidence-backed judgment to the user. Nothing is applied yet.
5. Only after explicit user approval: `patchbay_prepare_apply` (returns a prepare token), then `patchbay_apply` with the matching task hash, patch hash, base commit, and token. Apply touches the working tree only — it does not commit or push.

## Rules

- A worker's completion claim is never acceptance evidence — the clean verifier decides.
- Never auto-apply. Application is user-authorized (PRD P-04).
- Use `patchbay_review` and `patchbay_submit_finding_dispositions` for medium/high-risk work.
  Confirmed findings can start a repair job via `patchbay_repair`.
