---
name: patchbay:setup
description: Set up Patchbay — detect runtimes and provider credentials, and explain exactly which local tools and secrets are used. Run once per environment.
---

# $patchbay:setup

Interactive setup and repository initialization. Never print a credential value.

## Do this

1. Run `$patchbay:doctor` (the `patchbay_doctor` MCP tool) to detect Git, Node.js, OpenCode, the Claude reviewer, and container support.
2. For each worker the user wants (DeepSeek, GLM), tell them the exact environment variable to set:
   - DeepSeek → `DEEPSEEK_API_KEY`
   - GLM (Z.AI Coding Plan) → `ZAI_API_KEY`
   - Claude reviewer authenticates via the `claude` CLI's own login or `ANTHROPIC_API_KEY`.
3. Explain which local tools are invoked (OpenCode for workers, `claude` for review) and that nothing is transmitted except to the provider the user selected.
4. Re-run doctor and confirm the intended workflows now read `ready`.

## Not yet implemented (later milestones)

Writing `.patchbay/config.toml` and provider profile files is planned for Milestone 1. For now, setup is credential detection + disclosure only.
