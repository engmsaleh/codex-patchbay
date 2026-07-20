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

Optionally pin an isolated state dir: `codex mcp add patchbay --env PATCHBAY_DATA_DIR=/path -- node …`.
By default state lives under `~/.patchbay/data`.

Codex then sees the tools `patchbay_doctor`, `patchbay_estimate`, `patchbay_delegate`,
`patchbay_status`, `patchbay_result`, `patchbay_prepare_apply`, `patchbay_apply`, `patchbay_cancel`.

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

## Verified end-to-end loop

A real run (Codex → Patchbay → DeepSeek via OpenCode Go → clean verifier):

1. Codex called `patchbay_doctor` → DeepSeek profile ready.
2. Codex called `patchbay_delegate` with a contract to create `src/greet.js` exporting
   `greet(name)`, scoped to `src/**`, with a behavioral acceptance test.
3. The DeepSeek worker wrote the file in an isolated detached worktree.
4. Policy gate passed; the clean verifier ran `greet('World') === 'Hello, World!'` → passed.
5. Job reached `READY_TO_APPLY`; nothing was applied (human-approval gate).

> Note: `patchbay_delegate` is synchronous today — the Codex tool call blocks until the
> worker + verification finish. An async job runner (return a job id immediately, poll with
> `patchbay_status`, cancel a live worker) is the next increment; it also avoids MCP client
> timeouts on slower tasks.
