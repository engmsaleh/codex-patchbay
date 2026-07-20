# Codex Patchbay

> Codex routes the work. Workers propose patches. Evidence decides.

Codex Patchbay is a Codex plugin that keeps Codex as the orchestrator and final AI
judge while delegating bounded implementation tasks to lower-cost coding models
(DeepSeek, GLM) and, optionally, using Claude Code as an independent read-only
reviewer. Deterministic verification — not a model's self-report — decides whether a
candidate patch is acceptable.

> **Workers propose. Tools prove. Claude critiques. Codex judges. The user authorizes.**

See [`docs/prd.md`](./docs/prd.md) for the full product spec.

## Status

**Milestone 0 — plugin shell.** Implemented:

- Codex plugin manifest (`.codex-plugin/plugin.json`) and MCP config (`.mcp.json`).
- Namespaced skills (`$patchbay:doctor`, `$patchbay:setup`, and intent stubs for the rest).
- A bundled STDIO MCP server exposing the read-only `patchbay_doctor` tool.
- A prebuilt runtime (`dist/mcp-server.mjs`) with **no install/lifecycle scripts**.

Not yet built (Milestone 1+): contract validator, job state machine, worktree
isolation, worker delegation via OpenCode, clean verifier, Claude review, and the
safe apply guard.

## Requirements

- [Bun](https://bun.sh) 1.2+ (dev/build) and Node.js 20+ (runs the prebuilt server)
- Git
- [OpenCode](https://opencode.ai) — worker harness (for later milestones)
- [Claude Code](https://claude.com/claude-code) — optional reviewer

## Develop

```sh
bun install
bun test           # unit tests
bun run typecheck  # tsc --noEmit
bun run build      # produce dist/mcp-server.mjs and dist/cli.mjs
bun run doctor     # run the doctor from source
```

Run the doctor from the prebuilt runtime:

```sh
node dist/cli.mjs doctor
```

## How doctor reports credentials

Doctor reports each provider profile as `ready`, `degraded`, or `blocked` based on
whether its runtime binary and credential **env var** are present. It never reads or
prints a credential value — only the variable name and a present/absent boolean.

| Worker | Runtime | Credential env var |
|---|---|---|
| DeepSeek | OpenCode | `DEEPSEEK_API_KEY` |
| GLM (Z.AI) | OpenCode | `ZAI_API_KEY` |
| Claude reviewer | `claude` CLI | CLI login or `ANTHROPIC_API_KEY` |

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
