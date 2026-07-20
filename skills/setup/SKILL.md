---
name: patchbay:setup
description: Set up Patchbay — detect runtimes and provider credentials, and explain exactly which local tools and secrets are used. Run once per environment.
---

# $patchbay:setup

Interactive setup and repository initialization. Never print a credential value.

## Do this

1. Run `$patchbay:doctor` (the `patchbay_doctor` MCP tool) to detect Git, Node.js, OpenCode, the Claude reviewer, and container support.
2. Workers (DeepSeek and GLM) run through OpenCode using the **OpenCode Go subscription** — no per-provider API keys. If doctor shows the worker profiles as `degraded`, have the user run:
   ```sh
   opencode auth login    # choose OpenCode Go
   ```
   Patchbay copies only the selected provider's credential into each worker's isolated home; the rest of the environment is stripped.
   - (Alternative) direct provider keys are supported via a `provider_env` profile, but the subscription is the default path.
   - Claude reviewer authenticates via the `claude` CLI's own login or `ANTHROPIC_API_KEY`.
3. Explain which local tools are invoked (OpenCode for workers, `claude` for review) and that nothing is transmitted except to the provider the user selected.
4. Re-run doctor and confirm the intended workflows now read `ready`.

## Not yet implemented (later milestones)

Writing `.patchbay/config.toml` and provider profile files is planned for Milestone 1. For now, setup is credential detection + disclosure only.
