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
- Bundled STDIO MCP server with review and repair tools: `doctor`, `estimate`, `delegate`,
  `status`, `result`, `prepare_apply`, `apply`, `verify`, `logs`, `cancel`, `review`,
  `submit_finding_dispositions`, `repair`, and `receipts`.
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
- **Claude review + dispositions + repair round**: `patchbay_review` invokes an external reviewer
  against verified candidates, findings can be confirmed/rejected via `patchbay_submit_finding_dispositions`,
  and confirmed findings can start bounded repair work via `patchbay_repair`. `patchbay_receipts`
  aggregates recent jobs, findings, and dispositions for review.

**Async job runner**: `patchbay_delegate` returns a `job_id` immediately and runs the worker
in the background; poll `patchbay_status`/`patchbay_result` until `READY_TO_APPLY` or a terminal
failure. If a job becomes `STALE` due HEAD movement, `patchbay_prepare_apply` re-integrates and
re-verifies before issuing a fresh apply plan.

Not yet built: container secure mode + multi-process/multi-instance job-lock hardening (Milestone 3).

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

## Install in real Codex

From this repository root:

```sh
bun install
bun run build
codex mcp add patchbay -- node "$(pwd)/dist/mcp-server.mjs"
codex mcp get patchbay
```

Optional test state location:

```sh
codex mcp add patchbay --env PATCHBAY_DATA_DIR=/path/to/isolated/state -- node "$(pwd)/dist/mcp-server.mjs"
```

Remove the MCP server when done:

```sh
codex mcp remove patchbay
```

Closed-loop testing flow (recommended):

1. In one shell, keep dependencies ready and install plugin once:
```sh
opencode auth login
codex mcp add patchbay -- node "/absolute/path/to/codex-patchbay/dist/mcp-server.mjs"
```
2. In target repo, run a guided non-interactive Codex pass:
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Use patchbay_doctor, then delegate a small scoped task, then wait for verification evidence."
```
3. If Codex returns a job id, run follow-up turns for status and evidence:
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Call patchbay_status for job, then patchbay_result. If fails, call patchbay_logs."
```
4. For issues:
```sh
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/target-repo \
  "Apply patchbay_submit_finding_dispositions for confirmed review findings, then run patchbay_repair. Re-check with patchbay_result."
```

Fallback local loop (no Codex/OpenCode call needed):

```sh
bun test
```

This uses the fake worker path and verifies the full async/verify/logging flow in CI-like isolation.

Useful model overrides for the run:

- `PATCHBAY_DEEPSEEK_FAST_MODEL`
- `PATCHBAY_DEEPSEEK_CAPABLE_MODEL`
- `PATCHBAY_GLM_FAST_MODEL`
- `PATCHBAY_GLM_CAPABLE_MODEL`
- `PATCHBAY_OPENCODE_AUTH` (custom auth file path for OpenCode)

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
