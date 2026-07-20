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

**Milestone 1 — verified delegation core (fake worker).** Implemented:

- Codex plugin manifest (`.codex-plugin/plugin.json`), MCP config, and namespaced skills.
- Bundled STDIO MCP server with 8 `patchbay_` tools: `doctor`, `estimate`, `delegate`,
  `status`, `result`, `prepare_apply`, `apply`, `cancel`.
- Typed task contract (zod) with canonicalization + SHA-256 task hashing.
- Detached-worktree isolation at an exact base commit; full change inventory (incl. untracked).
- Patch policy gate: scope/protected-path enforcement, file-count/diff-size limits,
  binary/symlink/lockfile checks, private-key scan.
- Clean verifier: applies the candidate to a **fresh** worktree, confirms the applied hash,
  runs acceptance commands (argv only) with timeouts. A worker's own test claim is never trusted.
- Durable job store + compare-and-set state machine (survives restart); per-job receipts.
- Hash-gated apply guard: prepare token + task/patch/base/HEAD/clean checks before applying
  to the working tree. Never commits, pushes, merges, or stages.
- A `fake` worker runtime (testkit) so the full pipeline runs in CI with no provider credentials.
- **OpenCode worker adapter** driving DeepSeek/GLM via the **OpenCode Go subscription**
  (`opencode auth login`) — no per-provider API keys. The worker runs with a deny-first
  OpenCode config, a stripped environment, and only the selected provider's credential copied
  into an isolated temp home. Model IDs are configurable aliases, not source constants.

Not yet built: Claude review + one repair round (Milestone 2), an async background job runner
with live-process cancellation, and container secure mode + crash recovery (Milestone 3).

### Auth

Workers use your OpenCode Go subscription. Authenticate once:

```sh
opencode auth login    # choose OpenCode Go
```

Then `patchbay_doctor` reports the DeepSeek and GLM profiles as `ready`. Available worker
profiles: `deepseek-fast`, `deepseek-capable`, `glm-fast`, `glm-capable`.

### Try it

```sh
bun test          # 20 tests: doctor, policy, full-pipeline, and OpenCode-adapter conformance
```

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
