# Codex integration

Patchbay runs as an MCP server that the OpenAI Codex CLI (`codex`) launches over stdio.
Verified against `codex-cli 0.144.6`.

## Install

Build the prebuilt runtime, then register the server with Codex:

```sh
bun run build   # produces dist/mcp-server.mjs (no install/lifecycle scripts)
codex mcp add patchbay -- node /absolute/path/to/codex-patchbay/dist/mcp-server.mjs
```

This adds a `[mcp_servers.patchbay]` entry to `~/.codex/config.toml`. Confirm with:

```sh
codex mcp get patchbay      # shows command/args/enabled
codex mcp remove patchbay   # to uninstall
```

Optionally pin an isolated state dir:

```sh
codex mcp add patchbay --env PATCHBAY_DATA_DIR=/path/to/state -- node /absolute/path/to/codex-patchbay/dist/mcp-server.mjs
```
By default state lives under `~/.patchbay/data`.

Codex then sees the tools `patchbay_doctor`, `patchbay_estimate`, `patchbay_delegate`,
`patchbay_status`, `patchbay_result`, `patchbay_prepare_apply`, `patchbay_apply`,
`patchbay_verify`, `patchbay_logs`, `patchbay_cancel`, `patchbay_review`,
`patchbay_submit_finding_dispositions`, `patchbay_repair`, and `patchbay_receipts`.

Useful model selectors:

`PATCHBAY_DEEPSEEK_FAST_MODEL`, `PATCHBAY_DEEPSEEK_CAPABLE_MODEL`, `PATCHBAY_GLM_FAST_MODEL`, `PATCHBAY_GLM_CAPABLE_MODEL`  
`PATCHBAY_OPENCODE_AUTH` (override OpenCode auth file path).

## Auth

Workers use the OpenCode Go subscription — run `opencode auth login` once. No per-provider
API keys are needed.

## Drive the loop non-interactively

`codex exec` runs Codex headless and auto-approves MCP tool calls, which is useful for
integration testing:

```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  -o last-message.txt "Use patchbay to delegate <task>; report the verification evidence; do not apply."
```

`--json` streams JSONL events (tool calls, results) to stdout for diagnosis; `-o` writes
Codex's final message to a file.

A deterministic closed loop:

1. run doctor and warm-up delegation
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Call patchbay_doctor and report DeepSeek/GLM readiness."
```
2. create a scoped task and capture the returned `job_id`
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Call patchbay_delegate for a small change in src/ only with a simple acceptance command."
```
3. poll until terminal
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Call patchbay_status for that job_id until READY_TO_APPLY or terminal, then call patchbay_result."
```
4. inspect logs on failure
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Call patchbay_logs for that job_id with stream true and maxBytes 200000."
```
5. if needed, reopen for review/rework
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "If findings are present, call patchbay_submit_finding_dispositions then patchbay_repair; otherwise rerun patchbay_delegate with updated prompt."
```

Fallback local loop (no external Codex toolchain required):

```sh
bun test
```

`bun test` runs the fake-worker path and still exercises the async status/result/logging/verify pipeline for rapid regression.

## Verified end-to-end loop

A real run (Codex → Patchbay → DeepSeek via OpenCode Go → clean verifier):

1. Codex called `patchbay_doctor` → DeepSeek profile ready.
2. Codex called `patchbay_delegate` with a contract to create `src/greet.js` exporting
   `greet(name)`, scoped to `src/**`, with a behavioral acceptance test.
3. The DeepSeek worker wrote the file in an isolated detached worktree.
4. Policy gate passed; the clean verifier ran `greet('World') === 'Hello, World!'` → passed.
5. Job reached `READY_TO_APPLY` (or `CHANGES_REQUESTED` when review findings exist); nothing was applied (human-approval gate).
6. If the job is `CHANGES_REQUESTED`, review findings can be manually or automatically accepted via
   `patchbay_submit_finding_dispositions`, and confirmed findings can start a repair round with
   `patchbay_repair`.

> `patchbay_delegate` is asynchronous: it returns a `job_id` immediately and runs the worker
> in the background inside the MCP server process. Codex polls `patchbay_status { jobId }`
> until `READY_TO_APPLY`, `CHANGES_REQUESTED`, or a terminal failure, then reads `patchbay_result`.
> If the checkout moved in between verification and apply, `patchbay_result` reports a `STALE` candidate and
> `patchbay_prepare_apply` performs a best-effort re-integration before re-authorizing apply.
> This avoids MCP client timeouts on slower tasks. `patchbay_cancel { jobId }` aborts a running worker
> (process-group kill). Keep the Codex session (and thus the server) alive until the job is terminal — restart
> recovery brings jobs back into a safe state.
