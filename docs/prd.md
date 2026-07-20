# Codex Patchbay

## Product Requirements Document

**Document status:** Draft for implementation  
**Version:** 1.0  
**Date:** 2026-07-20  
**Proposed open-source license:** Apache-2.0  
**Proposed repository:** `engmsaleh/codex-patchbay`  
**Proposed plugin slug:** `patchbay`  
**Proposed npm package:** `codex-patchbay` (subject to npm availability)  
**Primary host:** OpenAI Codex  
**Primary worker runtimes:** OpenCode for DeepSeek and GLM  
**Primary independent reviewer:** Claude Code  

> **Tagline:** Codex routes the work. Workers propose patches. Evidence decides.

---

## 1. Executive summary

Codex Patchbay is an open-source Codex plugin that lets Codex remain the main orchestrator and final AI judge while delegating bounded implementation tasks to lower-cost coding models such as DeepSeek and GLM. Claude Code can be invoked as an independent, read-only reviewer for medium- and high-risk changes. Deterministic verification—not a model’s self-report—decides whether a candidate patch satisfies tests, linting, type checks, repository policies, and task-specific acceptance criteria.

The product is intentionally not a free-form multi-agent swarm. It is a controlled engineering pipeline with explicit authority boundaries:

1. The user defines the goal.
2. Codex understands the repository, decomposes the work, classifies risk, chooses workers, and creates a bounded task contract.
3. Patchbay creates an isolated worktree and launches the selected worker through a coding-agent runtime.
4. The worker proposes a candidate patch but cannot approve, apply, merge, push, or release it.
5. Patchbay extracts and policy-checks the patch, applies it to a clean verifier worktree, and runs the actual acceptance commands.
6. Claude Code optionally reviews the verified candidate in a read-only environment and returns structured findings.
7. Codex validates each finding, requests at most a bounded repair pass, and makes the final AI judgment.
8. The user authorizes application, merge, or release.

The product’s central invariant is:

> **Workers propose. Tools prove. Claude critiques. Codex judges. The user authorizes.**

---

## 2. Naming decision

### 2.1 Recommended public name

# **Codex Patchbay**

A physical patchbay routes signals between sources and destinations without becoming the source of those signals. This product similarly routes well-scoped engineering work among Codex, DeepSeek, GLM, Claude Code, and deterministic tools while preserving a single control point.

The name also carries a useful code-specific double meaning: every worker ultimately returns a **patch**.

### 2.2 Brand and package identifiers

| Surface | Proposed value |
|---|---|
| Public product name | Codex Patchbay |
| Short name | Patchbay |
| Codex plugin slug | `patchbay` |
| GitHub repository | `engmsaleh/codex-patchbay` |
| npm package | `codex-patchbay` (subject to npm availability) |
| MCP server ID | `patchbay` |
| Local state directory | `patchbay/` inside the Codex plugin data directory |
| Repo configuration directory | `.patchbay/` |
| CLI/debug executable | `patchbay` |
| Log prefix | `[patchbay]` |

### 2.3 Command namespace

```text
$patchbay:setup
$patchbay:doctor
$patchbay:orchestrate
$patchbay:delegate
$patchbay:review
$patchbay:status
$patchbay:result
$patchbay:cancel
$patchbay:receipts
```

### 2.4 Naming caveat

A preliminary repository and package-name scan did not surface a prominent exact collision for **Codex Patchbay**, but “patchbay” is a generic software and audio-routing term. This is not legal or trademark clearance. Before public launch, the maintainers should perform a formal trademark, repository-name, package-name, and domain review.

### 2.5 Fallback name

If legal distinctiveness matters more than the routing metaphor, the strongest fallback is **Codex Patchgate**. “Patchgate” emphasizes the verified acceptance gate but communicates multi-model routing less clearly.

---

## 3. Product vision

Make high-quality coding-agent orchestration economical, auditable, and safe enough for daily engineering work.

Codex should spend its expensive context and reasoning on the decisions for which it is most valuable:

- understanding intent;
- decomposing ambiguous work;
- identifying risk;
- selecting the right worker;
- evaluating architecture and tradeoffs;
- validating review findings;
- deciding whether a result is acceptable.

Lower-cost models should perform bounded implementation work where success can be described and verified objectively. Claude Code should provide an independent model lineage for adversarial review when the cost is justified. Software—not prompts alone—should enforce budgets, workspace isolation, path policies, process ownership, clean verification, and safe integration.

---

## 4. Problem statement

Coding agents are increasingly capable, but using multiple models effectively remains awkward and risky.

Current approaches tend to have one or more of these shortcomings:

- The most expensive model performs both high-value judgment and repetitive implementation.
- Delegated workers operate in the main checkout and can interfere with the user or one another.
- A worker is trusted when it claims that tests passed.
- Prompts are treated as security boundaries even though an agent can invoke alternative tools or shell commands.
- Worker outputs are unstructured and difficult to compare, audit, or resume.
- External model credentials are exposed to unrelated subprocesses.
- Background work has weak ownership, cancellation, and crash-recovery semantics.
- Review loops run without hard budgets and consume subscriptions or API credits indefinitely.
- The reviewer’s findings are treated as authoritative even when they are false positives.
- A green patch produced from an old base is applied to a newer checkout without re-verification.
- Multi-agent products optimize for impressive diagrams rather than reliable software delivery.

Patchbay addresses these problems by combining a Codex-native workflow with a local, typed, policy-enforcing control plane.

---

## 5. Product principles and non-negotiable invariants

### P-01: Codex owns orchestration

Codex creates the task contract, chooses the worker profile, decides whether review is required, validates reviewer findings, and makes the final AI judgment.

### P-02: The worker never grades its own work

Worker-run test output may be captured for debugging, but it is not acceptance evidence. Acceptance checks run again in a clean verifier environment controlled by Patchbay.

### P-03: Claude reviews; Claude does not rule

Claude Code returns evidence-backed findings. Codex validates and classifies each finding before it becomes a repair requirement.

### P-04: The user controls consequential application

Version 1 must not automatically push, merge, publish, deploy, or release. Applying a verified candidate to the active checkout requires explicit approval.

### P-05: Every write-capable worker is isolated

A worker receives its own detached Git worktree. Secure mode additionally runs the process in a container or equivalent operating-system sandbox.

### P-06: Every task is a typed, immutable contract

The objective, non-goals, base commit, allowed paths, forbidden paths, commands, budgets, and policies are validated, canonicalized, hashed, and retained.

### P-07: Results are base- and hash-bound

No candidate may be applied unless its expected base commit, task hash, patch hash, and verification receipt match the current operation.

### P-08: Model names and prices are configuration, not product logic

Provider aliases, model IDs, limits, and pricing change. Patchbay resolves these through versioned worker profiles and health checks.

### P-09: Prompts guide; software enforces

Path restrictions, command policies, process limits, credential isolation, state transitions, and apply rules are enforced outside the model.

### P-10: No recursive worker delegation by default

DeepSeek, GLM, and Claude reviewer jobs may not spawn Patchbay jobs or unrelated subagents. Codex is the only orchestration root in version 1.

### P-11: Review follows deterministic verification

Do not spend reviewer budget on candidates that already fail objective checks, except when Codex explicitly requests diagnostic review.

### P-12: Everything load-bearing leaves a receipt

Task contracts, patches, checks, findings, state transitions, costs, and final disposition are retained as auditable artifacts with hashes.

---

## 6. Goals

### 6.1 Version 0.1 goals

1. Install as a real Codex plugin with namespaced skills and a bundled local MCP server.
2. Keep the main Codex thread as orchestrator and final AI judge.
3. Delegate a bounded write task to one DeepSeek worker through OpenCode.
4. Create an isolated detached Git worktree at an exact base commit.
5. Enforce allowed and forbidden file paths after execution.
6. Extract a canonical patch and calculate its hash.
7. Apply the candidate to a second clean verifier worktree.
8. Run task-defined acceptance commands using argv arrays and timeouts.
9. Track jobs in the background with status, result, log, and cancellation tools.
10. Require explicit approval before applying a verified patch to the active checkout.
11. Produce a structured receipt for every terminal job.

### 6.2 Version 0.2 goals

1. Add GLM worker profiles through OpenCode.
2. Add Claude Code as a read-only structured reviewer.
3. Support one bounded repair pass for confirmed findings.
4. Add provider health, quota, and capability reporting.
5. Add deterministic risk-based worker and review recommendations.
6. Add hardened credential filtering and temporary per-job homes.
7. Add crash recovery, stale worktree pruning, and orphan-process cleanup.

### 6.3 Version 1.0 goals

1. Support secure container-backed execution on Linux, macOS, and WSL2.
2. Provide a stable runtime adapter API for additional workers.
3. Support concurrent read-only jobs and serialized or disjoint-path write jobs.
4. Provide evidence-based routing from local benchmark and historical results.
5. Publish signed, reproducible plugin releases and a compatibility matrix.
6. Make telemetry strictly opt-in and privacy-preserving.
7. Provide strong documentation, threat modeling, migration guidance, and an extension SDK.

---

## 7. Non-goals

Version 1 will not attempt to provide:

1. A general-purpose autonomous swarm.
2. Arbitrary cyclic agent-to-agent conversation.
3. Automatic Git pushes, pull-request merges, releases, or deployments.
4. A hosted SaaS control plane.
5. Multi-user tenancy or centralized organization administration.
6. Unbounded arbitrary shell execution exposed as an MCP tool.
7. A raw custom tool-use loop for every provider.
8. Guaranteed semantic correctness beyond available tests, policies, and review evidence.
9. Cross-repository transactional changes.
10. Autonomous conflict resolution when the active branch has moved.
11. Storage of hidden model reasoning.
12. A browser dashboard in the first stable release.
13. Native Windows execution outside WSL2 until equivalent isolation and process controls are proven.
14. Provider procurement, subscription management, or billing mediation.

---

## 8. Target users and personas

### 8.1 Cost-conscious individual developer

Uses Codex for architectural judgment but wants DeepSeek or GLM to perform repetitive implementation. Needs simple setup, predictable costs, and confidence that the worker cannot silently push or modify unrelated files.

### 8.2 Open-source maintainer

Needs to delegate issue-sized changes while preserving repository rules and reviewing every accepted patch. Values transparent receipts, provider neutrality, and an open extension interface.

### 8.3 Staff engineer or technical lead

Wants Codex to decompose work and retain final judgment, with Claude providing independent adversarial review on risky changes. Needs reproducibility, explicit acceptance criteria, and auditable decisions.

### 8.4 Security-conscious team

Wants local execution, credential minimization, no default telemetry, sandboxing, protected paths, and explicit human approval before integration.

### 8.5 Model and agent researcher

Wants to compare worker models on repository-specific tasks using verified outcomes rather than subjective completion reports.

---

## 9. Jobs to be done

1. “When I have a bounded implementation task, let Codex send it to a cheaper worker and return a verifiable patch.”
2. “When a patch is risky, ask a different model to find defects without letting it modify the code.”
3. “When a worker says it is finished, show me the actual diff and clean verification evidence.”
4. “When my branch moves, prevent an old green result from being applied without rechecking it.”
5. “When a worker hangs or goes off course, let me cancel it and recover safely.”
6. “When I compare providers, show cost, time, pass rate, repair frequency, and scope violations.”
7. “When I install a plugin, avoid forcing me to trust an opaque daemon or hosted service.”

---

## 10. Primary user journeys

### 10.1 Initial setup

1. User installs the Patchbay plugin from a Codex plugin marketplace or source.
2. User invokes `$patchbay:setup`.
3. Patchbay detects Git, Node.js, OpenCode, Claude Code, container support, and configured provider credentials.
4. User selects DeepSeek and/or GLM worker profiles and an optional Claude reviewer.
5. Patchbay writes user-level configuration in the plugin data directory.
6. In a repository, Patchbay proposes a `.patchbay/config.toml` and an `AGENTS.md` compatibility check.
7. `$patchbay:doctor` reports ready, degraded, or blocked capabilities without printing secrets.

### 10.2 Delegate a low-risk task

User says:

```text
Use Patchbay. Have the cheapest healthy worker add boundary tests for invitation expiry. Only modify tests/invitations. Run the invitation tests and typecheck. Do not apply anything until I approve it.
```

Codex:

1. classifies the task as low risk;
2. writes a task contract;
3. selects `deepseek-fast` or `glm-fast`;
4. invokes `patchbay_delegate`;
5. continues other analysis or waits;
6. retrieves the candidate and verification receipt;
7. reviews the diff;
8. reports its final judgment;
9. asks for approval before application.

### 10.3 Delegate a medium-risk feature

Codex delegates implementation to a capable DeepSeek or GLM profile. After the candidate passes objective checks, Codex requests Claude review. Claude returns structured findings. Codex confirms or rejects each finding and may issue one repair task. Patchbay re-verifies the repaired candidate before Codex decides.

### 10.4 Keep a high-risk change with Codex

For authentication, authorization, payments, destructive migrations, cryptography, or infrastructure, Codex retains implementation ownership. It may delegate narrow read-only research or test generation, then ask Claude for adversarial review. Patchbay does not force delegation merely because a cheap worker exists.

### 10.5 Cancel a worker

User or Codex calls `patchbay_cancel`. Patchbay verifies job ownership, transitions the job atomically, terminates the exact process tree using process identity rather than PID alone, preserves partial artifacts, and cleans or quarantines the worktree.

### 10.6 Recover after a crash

At the next session start, Patchbay scans nonterminal jobs, checks process identity and heartbeats, marks abandoned work appropriately, prunes stale worktrees, and surfaces recoverable results. It never assumes that a reused PID belongs to the original worker.

### 10.7 Apply a verified patch

1. Codex calls `patchbay_prepare_apply`.
2. Patchbay verifies the task hash, patch hash, verification receipt, repository identity, current HEAD, and active-checkout cleanliness.
3. If current HEAD equals the candidate base, Patchbay presents an apply plan.
4. The user approves the `patchbay_apply` MCP call.
5. Patchbay applies the exact patch, verifies resulting tree hash, and records the disposition.
6. It does not commit or push.

---

## 11. User experience and commands

The plugin’s skills should be small workflow contracts. Durable mechanics belong in MCP tools and the local control plane.

### 11.1 `$patchbay:setup`

Purpose: interactive setup and repository initialization.

Expected behavior:

- inspect supported runtimes;
- create or update provider profiles;
- configure secure/default execution mode;
- optionally create `.patchbay/config.toml`;
- explain exactly which secrets and local tools are used;
- run doctor checks;
- never print credentials.

### 11.2 `$patchbay:doctor`

Purpose: health and compatibility diagnosis.

Example output:

```text
Patchbay doctor

Codex plugin runtime      ready
Git                        2.5x, ready
OpenCode                   ready
DeepSeek profile           ready
GLM Coding Plan profile    degraded: authentication missing
Claude Code reviewer       ready
Container sandbox          ready: Docker
Repository                 ready, clean HEAD a7fdcb6
Protected-path policy      loaded

Available workflows: DeepSeek implementation, Claude review
Unavailable: GLM implementation
```

### 11.3 `$patchbay:orchestrate <goal>`

Purpose: let Codex perform the full decision workflow.

Codex should:

1. determine whether delegation is suitable;
2. define a typed contract;
3. select a worker;
4. initiate and monitor the job;
5. request review according to policy;
6. validate findings;
7. deliver a final evidence-backed judgment.

### 11.4 `$patchbay:delegate`

Purpose: explicitly send a bounded task to a selected worker.

Illustrative syntax:

```text
$patchbay:delegate --worker deepseek-fast --review auto \
  "Add invitation expiry boundary tests; only modify tests/invitations."
```

### 11.5 `$patchbay:review`

Purpose: independently review a candidate, branch, commit range, or working-tree diff.

Modes:

- `standard`: correctness, regressions, missing tests;
- `adversarial`: challenge assumptions, concurrency, rollback, abuse cases;
- `security`: permissions, data exposure, injection, unsafe defaults;
- `design`: boundaries, coupling, maintainability, API semantics.

Review defaults to read-only and structured output.

### 11.6 `$patchbay:status`

Purpose: show jobs owned by the current Codex session and optionally all jobs in the repository.

### 11.7 `$patchbay:result <job-id>`

Purpose: load a completed result, candidate summary, diff metadata, verification result, and artifact references into Codex.

### 11.8 `$patchbay:cancel <job-id>`

Purpose: cancel an owned active job. Cross-session cancellation requires explicit confirmation.

### 11.9 `$patchbay:receipts`

Purpose: show recent jobs, worker, cost/quota, duration, pass/fail, review findings, and disposition.

---

## 12. Authority and responsibility model

| Actor | May plan | May edit candidate | May run checks | May review | May accept | May apply | May push/merge |
|---|---:|---:|---:|---:|---:|---:|---:|
| User | Yes | Yes | Yes | Yes | Ultimate authority | Yes | Yes |
| Main Codex | Yes | Yes when retained locally | Requests/reads evidence | Yes | Final AI judgment | Requests with approval | No by Patchbay |
| DeepSeek worker | No orchestration | Isolated worktree only | Debug checks only | No self-approval | No | No | No |
| GLM worker | No orchestration | Isolated worktree only | Debug checks only | No self-approval | No | No | No |
| Claude reviewer | No orchestration | No | Limited read-only diagnostics | Yes | No | No | No |
| Patchbay control plane | Executes contract | Applies only in isolated contexts | Official verifier | Coordinates | Mechanical policy only | After approval | No |
| Deterministic verifier | No | Clean verifier worktree | Yes | No | Objective gate only | No | No |

---

## 13. High-level architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                         USER                                  │
└──────────────────────────────┬────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                    CODEX MAIN THREAD                          │
│                                                               │
│  Understands intent       Decomposes work                     │
│  Classifies risk         Selects worker                       │
│  Defines contract        Validates review findings            │
│  Makes final AI judgment                                     │
└──────────────────────────────┬────────────────────────────────┘
                               │ typed MCP tools
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                 PATCHBAY CONTROL PLANE                        │
│                                                               │
│  Contract validator       Job/state manager                   │
│  Runtime registry         Process supervisor                  │
│  Worktree manager         Sandbox and credentials             │
│  Patch policy gate        Clean verifier                      │
│  Review coordinator       Apply guard                         │
│  Artifact store           Receipt ledger                      │
└──────────────┬────────────────────┬───────────────────┬───────┘
               │                    │                   │
               ▼                    ▼                   ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ DeepSeek / OpenCode │  │ GLM / OpenCode      │  │ Claude Code review  │
│ write-capable       │  │ write-capable       │  │ read-only           │
│ isolated worktree   │  │ isolated worktree   │  │ structured findings │
└──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘
           └────────────────────────┴─────────────────────────┘
                                    ▼
                         ┌──────────────────────┐
                         │ CLEAN VERIFIER       │
                         │ exact base + patch   │
                         │ policy + real checks │
                         └──────────┬───────────┘
                                    ▼
                           CODEX FINAL JUDGMENT
                                    ▼
                              USER APPROVAL
```

---

## 14. Architectural decisions

### AD-01: Codex plugin plus local MCP server

The plugin supplies discoverable skills, configuration, optional lifecycle hooks, and interface metadata. The MCP server supplies typed, durable execution tools. This keeps the user experience Codex-native without forcing orchestration logic into prose prompts.

### AD-02: Local-first control plane

All source code, patches, logs, credentials, and state remain local except for requests sent to the explicitly selected model provider through its coding harness.

### AD-03: OpenCode as the default cheap-worker harness

OpenCode provides noninteractive execution, provider/model selection, JSON event output, per-agent permissions, and support for both DeepSeek and GLM routes. Patchbay avoids rebuilding a full coding-agent loop in version 1.

### AD-04: Claude Code as a distinct reviewer runtime

Claude Code has a strong noninteractive interface, structured output options, turn and budget controls, and tool restrictions. The reviewer operates on a read-only candidate and never applies changes.

### AD-05: SQLite-compatible durable state

Jobs, transitions, artifacts, checks, and findings require transactional state. The implementation must use SQLite through a distribution-compatible implementation. Native modules that require installation scripts are disallowed unless prebuilt and signed for every supported platform.

### AD-06: Prebuilt plugin runtime

Codex plugin installation must not depend on npm lifecycle scripts. Published plugin artifacts include compiled JavaScript, schemas, prompts, and any portable runtime assets.

### AD-07: Explicit job-ID tools before MCP Tasks

Version 1 uses ordinary MCP tools returning durable job IDs. The MCP Tasks extension may be adopted behind a compatibility layer when host support is stable and negotiated.

### AD-08: No automatic apply by default

`patchbay_apply` requires a user approval prompt and exact expected hashes. Automatic apply may later be available only for opt-in low-risk policy classes.

### AD-09: No arbitrary shell MCP endpoint

Verification commands come from validated task contracts and repository policy. The server spawns processes directly with argv arrays and does not expose an unrestricted shell tool.

### AD-10: Risk policy is deterministic in the first release

Codex can reason about risk, but the control plane independently enforces protected categories and paths. Historical performance-based routing comes later.

---

## 15. Proposed repository structure

```text
codex-patchbay/
├── .codex-plugin/
│   └── plugin.json
├── .mcp.json
├── skills/
│   ├── setup/SKILL.md
│   ├── doctor/SKILL.md
│   ├── orchestrate/SKILL.md
│   ├── delegate/SKILL.md
│   ├── review/SKILL.md
│   ├── status/SKILL.md
│   ├── result/SKILL.md
│   ├── cancel/SKILL.md
│   └── receipts/SKILL.md
├── hooks/
│   ├── hooks.json
│   ├── session-start.mjs
│   └── unread-results.mjs
├── packages/
│   ├── core/
│   ├── mcp-server/
│   ├── runtime-opencode/
│   ├── runtime-claude/
│   ├── sandbox/
│   ├── git/
│   ├── verifier/
│   ├── policy/
│   ├── storage/
│   ├── schemas/
│   ├── cli/
│   └── testkit/
├── profiles/
│   ├── deepseek-fast.toml
│   ├── deepseek-capable.toml
│   ├── glm-fast.toml
│   ├── glm-capable.toml
│   └── claude-review.toml
├── schemas/
│   ├── task.schema.json
│   ├── worker-result.schema.json
│   ├── verification.schema.json
│   ├── review.schema.json
│   └── receipt.schema.json
├── prompts/
│   ├── worker-system.md
│   ├── worker-task.md
│   ├── review-standard.md
│   ├── review-adversarial.md
│   └── repair.md
├── dist/
│   ├── mcp-server.mjs
│   ├── patchbay.mjs
│   └── source-manifest.json
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── provider-setup.md
│   ├── plugin-development.md
│   ├── configuration.md
│   └── extension-sdk.md
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── adversarial/
│   ├── fault-injection/
│   └── fixtures/
├── evals/
│   ├── tasks/
│   ├── runners/
│   └── reports/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── GOVERNANCE.md
└── README.md
```

---

## 16. Core component requirements

### 16.1 Codex plugin manifest

The manifest must declare:

- plugin name and semantic version;
- user-facing description;
- Apache-2.0 license;
- skills directory;
- hooks manifest;
- MCP server configuration;
- display name, category, icon, logo, and default prompts;
- capabilities accurately reflecting read and write operations.

The plugin must remain useful if optional hooks are not trusted. Hooks improve discoverability and notifications but are not required for correctness or safety.

### 16.2 Orchestrator skill

The orchestrator skill tells Codex to:

1. inspect the repository and existing `AGENTS.md` instructions;
2. determine whether the task is delegable;
3. classify task risk;
4. compile an explicit task contract;
5. select a healthy worker profile;
6. avoid sending unrelated conversation context;
7. retrieve and inspect the actual candidate patch;
8. use deterministic evidence before trusting completion;
9. request Claude review according to policy;
10. validate every finding;
11. stop after the configured repair budget;
12. provide the user a final evidence-backed recommendation.

The skill must explicitly prohibit Codex from treating a worker’s prose summary as acceptance evidence.

### 16.3 Contract validator and canonicalizer

Responsibilities:

- validate the JSON contract against a versioned schema;
- reject unknown security-sensitive fields by default;
- resolve repository root and exact base commit;
- normalize paths to repository-relative POSIX form;
- reject absolute paths, `..`, null bytes, and path escapes;
- normalize command argv arrays;
- canonicalize JSON using deterministic key ordering;
- calculate SHA-256 task hash;
- store the immutable contract artifact.

### 16.4 Context compiler

Produces a bounded worker bundle containing:

- objective and non-goals;
- repository rules;
- exact base commit;
- allowed and forbidden paths;
- relevant file and symbol summaries;
- known error output;
- acceptance commands;
- budget and policy constraints;
- required result format.

It must not forward the full Codex conversation, unrelated user data, hidden reasoning, or credentials.

### 16.5 Runtime registry

Maintains adapters and worker profiles. Each profile declares:

- runtime ID;
- provider ID;
- model resolver;
- mode: read or write;
- capabilities;
- credential source names;
- maximum steps and wall time;
- maximum output bytes;
- default diff and file limits;
- network policy;
- whether structured output is native;
- whether session resume is supported;
- cost/quota reporting mode.

### 16.6 Job manager

Responsibilities:

- create globally unique sortable job IDs;
- bind jobs to Codex session and repository identity;
- enforce legal state transitions with compare-and-set semantics;
- maintain heartbeats and process identity;
- recover nonterminal jobs after restart;
- serialize integration operations;
- cap concurrent read and write jobs;
- expose bounded logs and progress events;
- perform retention cleanup.

### 16.7 Worktree manager

Responsibilities:

- reject or explicitly snapshot an unsupported dirty checkout;
- resolve exact base commit;
- create detached worktrees in a private runtime directory;
- ensure worktree paths have restrictive permissions;
- prune stale registrations and directories;
- retain failed worktrees according to policy for diagnosis;
- never remove a directory not proven to belong to Patchbay;
- maintain a manifest containing repository ID, job ID, base SHA, and creation time.

### 16.8 Sandbox manager

Execution modes:

- `secure`: container/VM-backed, network denied unless explicitly allowed;
- `standard`: worktree plus harness permissions and sanitized environment;
- `unsafe-dev`: explicit opt-in for contributors and unsupported systems.

The job record and final receipt must state the actual isolation level. Patchbay must not describe worktree-only execution as a security sandbox.

### 16.9 Credential broker

Responsibilities:

- resolve only the selected provider’s required credentials;
- inject them through a minimal environment or isolated provider config;
- strip unrelated cloud, Git, SSH, package-publishing, and model credentials;
- redact secret values from logs and artifacts;
- never copy the user’s complete home directory;
- support provider-plan authentication without persisting plaintext secrets in the repository;
- fail closed when required credentials cannot be isolated.

A future secure mode may issue a short-lived local proxy token so the raw provider key never enters the worker container.

### 16.10 Patch extractor and policy gate

After worker exit, Patchbay must:

1. inventory tracked, staged, unstaged, and untracked changes;
2. reject changes outside allowed paths;
3. reject protected-path changes;
4. inspect symlinks, submodules, file modes, binary files, and oversized files;
5. reject or flag lockfile changes not explicitly allowed;
6. enforce changed-file and diff-line budgets;
7. scan for likely credentials and private keys;
8. produce a canonical patch from the exact base;
9. calculate patch SHA-256;
10. record tree and file metadata.

### 16.11 Clean verifier

The verifier must:

- create a new detached worktree at the exact base commit;
- apply the canonical patch;
- verify that the resulting diff matches the candidate hash;
- use no model-provider credentials;
- execute only approved argv commands;
- enforce per-command and total timeouts;
- capture exit code, duration, bounded stdout, bounded stderr, and artifact hashes;
- kill process trees on timeout or cancellation;
- distinguish test failure from environment failure;
- return a structured verification receipt.

### 16.12 Review coordinator

Responsibilities:

- run only after successful policy and deterministic verification unless diagnostic review is requested;
- provide Claude with the task, candidate diff, repository rules, and verification evidence;
- use a read-only mount or checkout;
- deny editing and recursive delegation;
- request JSON Schema-constrained findings;
- apply turn, wall-time, output, and cost limits;
- preserve raw output separately from parsed output;
- never silently convert parse failure into approval.

### 16.13 Finding validator workflow

Codex classifies each reviewer finding as:

- `confirmed`;
- `rejected_false_positive`;
- `duplicate`;
- `out_of_scope`;
- `needs_experiment`;
- `needs_human_decision`.

Only confirmed findings may enter an automatic repair task. Each finding should cite a file, line or symbol, evidence, reproduction path, severity, confidence, and suggested verification.

### 16.14 Repair coordinator

Version 1 permits one automatic repair round by default.

The repair worker receives:

- original immutable task;
- current candidate patch;
- confirmed findings only;
- failing deterministic evidence, if any;
- unchanged scope and budgets unless Codex explicitly narrows them.

After repair, the complete policy and verification pipeline runs again. A second failure or unresolved high-severity finding transitions to `needs_codex`.

### 16.15 Apply guard

The apply operation must verify:

- repository identity;
- current HEAD;
- active-checkout cleanliness;
- expected base commit;
- task hash;
- patch hash;
- successful latest verification receipt;
- review policy satisfaction;
- no superseding candidate;
- explicit user approval.

Patchbay applies the exact patch but does not commit, push, merge, or release.

### 16.16 Receipt ledger

Every terminal job creates a structured, human-readable receipt with:

- objective;
- task hash;
- repository pseudonymous ID;
- base commit;
- worker runtime/provider/model;
- actual isolation mode;
- start/end/duration;
- usage and reported cost/quota;
- changed files and patch statistics;
- policy result;
- verification commands and outcomes;
- review and finding classifications;
- repair count;
- final Codex disposition if supplied;
- application status;
- artifact hashes.

---

## 17. Runtime adapter specification

### 17.1 TypeScript interface

```ts
export interface WorkerRuntime {
  readonly id: string;

  doctor(profile: WorkerProfile): Promise<RuntimeHealth>;

  capabilities(profile: WorkerProfile): Promise<RuntimeCapabilities>;

  start(input: RunInput): Promise<ProcessHandle>;

  events(handle: ProcessHandle): AsyncIterable<WorkerEvent>;

  cancel(handle: ProcessHandle): Promise<void>;

  collect(handle: ProcessHandle): Promise<RawWorkerResult>;
}

export interface RuntimeCapabilities {
  editing: boolean;
  structuredOutput: boolean;
  resume: boolean;
  usageReporting: boolean;
  commandPermissions: boolean;
  filePermissions: boolean;
  nativeBudgetLimit: boolean;
}
```

### 17.2 OpenCode adapter

The OpenCode adapter must:

- invoke `opencode run` without an intermediate shell;
- set explicit working directory, agent, provider/model, and JSON event output;
- generate a per-job deny-first OpenCode configuration;
- disable task/subagent spawning;
- deny external directory access;
- deny Git commit and push;
- deny web access by default;
- allow only task-approved path edits and commands;
- parse event streams robustly;
- capture provider usage where available;
- map runtime errors into Patchbay error classes.

Illustrative command:

```text
opencode run
  --dir <worktree>
  --model <provider/model>
  --agent patchbay-worker
  --format json
  <compiled-task>
```

No provider model ID should be hard-coded in source. Profiles resolve aliases at runtime and doctor checks should warn before provider deprecations.

### 17.3 Claude Code adapter

The Claude adapter must:

- invoke noninteractive `claude -p`;
- request JSON or stream-JSON output;
- use JSON Schema-constrained reviewer output where supported;
- set explicit model, effort, maximum turns, and budget;
- use read-only/plan permission mode;
- allow only read/search tools needed for review;
- deny Edit, Write, arbitrary Bash, and recursive agent delegation;
- support session resume only for an explicitly linked review or repair investigation;
- parse and retain session ID, usage, and cost when available.

### 17.4 Future adapters

The extension API should permit later support for:

- Kimi CLI;
- Gemini CLI;
- local Ollama or LM Studio workers;
- another Codex worker;
- remote container workers;
- direct provider APIs.

New adapters must pass the runtime conformance suite and may not weaken core policy gates.

---

## 18. Worker profile format

Illustrative profile:

```toml
id = "deepseek-fast"
runtime = "opencode"
provider = "deepseek"
model_env = "PATCHBAY_DEEPSEEK_FAST_MODEL"
mode = "write"

[limits]
max_steps = 12
max_wall_seconds = 1200
max_output_bytes = 1048576
max_changed_files = 8
max_diff_lines = 400
max_repair_rounds = 1

[permissions]
network = false
recursive_delegation = false
git_commit = false
git_push = false
external_directories = false

[credentials]
env_allow = ["DEEPSEEK_API_KEY"]
env_deny_globs = ["AWS_*", "GITHUB_*", "NPM_*", "ANTHROPIC_*", "OPENAI_*"]

[cost]
mode = "provider_reported"
```

Profiles may be provided by the plugin, user, or repository. Managed policy has highest precedence, followed by repository, user, and plugin defaults. Repository configuration may narrow permissions and budgets but may not broaden managed security policy.

---

## 19. Task contract schema

### 19.1 Required fields

```json
{
  "schema_version": "1.0",
  "objective": "Reject invitation acceptance when the invitation is expired.",
  "non_goals": [
    "Do not change token generation.",
    "Do not alter authentication middleware."
  ],
  "repository": {
    "root": "/workspace/project",
    "base_commit": "a7fdcb6e4e7d...",
    "dirty_policy": "reject"
  },
  "scope": {
    "allow": [
      "src/invitations/**",
      "tests/invitations/**"
    ],
    "deny": [
      "src/auth/**",
      "database/**",
      ".github/**"
    ],
    "max_changed_files": 8,
    "max_diff_lines": 400,
    "allow_binary": false,
    "allow_symlink": false,
    "allow_lockfile": false
  },
  "acceptance": [
    {
      "id": "invitation-tests",
      "argv": ["pnpm", "test", "invitations"],
      "cwd": ".",
      "timeout_seconds": 600,
      "required": true
    },
    {
      "id": "types",
      "argv": ["pnpm", "typecheck"],
      "cwd": ".",
      "timeout_seconds": 600,
      "required": true
    }
  ],
  "worker": {
    "profile": "deepseek-fast",
    "selection_reason": "Low-risk bounded implementation with objective tests."
  },
  "review": {
    "policy": "on-risk",
    "profile": "claude-review",
    "modes": ["standard"]
  },
  "budget": {
    "max_wall_seconds": 1800,
    "max_steps": 15,
    "max_repair_rounds": 1,
    "max_cost_usd": 0.75
  },
  "policy": {
    "allow_network": false,
    "allow_commit": false,
    "allow_push": false,
    "recursive_delegation": false,
    "require_human_apply": true
  },
  "metadata": {
    "created_by": "codex",
    "codex_session_id": "opaque-session-id",
    "risk": "medium"
  }
}
```

### 19.2 Contract rules

- `objective` must be concrete and testable.
- `non_goals` must be present for write tasks.
- `base_commit` must resolve to a commit in the selected repository.
- `allow` must be nonempty for write tasks.
- `deny` always includes plugin-defined protected paths unless managed policy overrides with stricter rules.
- Commands are argv arrays; shell strings are rejected.
- The contract may not contain raw provider credentials.
- The canonical contract becomes immutable after job creation.
- Any scope or acceptance change creates a new contract version and task hash.

---

## 20. MCP tool API

All tool names use a stable `patchbay_` prefix. Schemas must be strict, versioned, and reject unknown properties for security-sensitive operations.

### 20.1 `patchbay_doctor`

**Safety:** read-only; eligible for automatic approval.  
**Input:** optional repository path and verbosity.  
**Output:** runtime, provider, sandbox, storage, Git, and repository health with redacted diagnostics.

### 20.2 `patchbay_workers`

**Safety:** read-only.  
**Output:** available profiles, capabilities, health, quota/cost mode, and recommended task classes.

### 20.3 `patchbay_estimate`

**Safety:** read-only.  
**Input:** draft task contract.  
**Output:** validation result, estimated risk, compatible workers, expected review policy, and hard limits. It must not claim precise cost when the provider cannot report one.

### 20.4 `patchbay_delegate`

**Safety:** creates a write-capable background job; approval policy should be configurable and visible.  
**Input:** complete task contract.  
**Output:** job ID, status, owner session, worker profile, base commit, task hash, and progress/log reference.

### 20.5 `patchbay_status`

**Safety:** read-only.  
**Input:** job ID or filter.  
**Output:** state, phase, progress, timestamps, worker, budget consumed, and next action.

### 20.6 `patchbay_result`

**Safety:** read-only.  
**Input:** job ID.  
**Output:** candidate summary, changed files, patch metadata, policy result, verification result, review result, and artifact references. Large raw patches should be returned by bounded artifact access rather than flooding model context.

### 20.7 `patchbay_logs`

**Safety:** read-only.  
**Input:** job ID, cursor, maximum bytes, stream selector.  
**Output:** bounded redacted log slice and next cursor.

### 20.8 `patchbay_cancel`

**Safety:** state-changing.  
**Input:** job ID and expected current state.  
**Output:** cancellation transition, process termination result, and retained artifacts.

### 20.9 `patchbay_verify`

**Safety:** executes approved commands in an isolated verifier.  
**Input:** job ID and expected patch hash.  
**Output:** verification receipt.

Normally invoked automatically by the job pipeline; exposed for explicit reruns and diagnostics.

### 20.10 `patchbay_review`

**Safety:** calls an external reviewer and may incur cost/quota.  
**Input:** job ID or explicit review target, profile, modes, and budget.  
**Output:** structured findings plus parse and runtime status.

### 20.11 `patchbay_submit_finding_dispositions`

**Safety:** records Codex judgment.  
**Input:** job ID, review hash, and classification for every finding.  
**Output:** accepted classifications and whether a repair task may be created.

### 20.12 `patchbay_repair`

**Safety:** creates a write-capable job.  
**Input:** source job, expected patch/review hashes, confirmed finding IDs, and worker profile.  
**Output:** child job ID and inherited contract metadata.

### 20.13 `patchbay_prepare_apply`

**Safety:** read-only preparation with strong validation.  
**Input:** job ID, expected patch hash, target repository.  
**Output:** readiness, current HEAD, expected base, changed files, verification and review status, conflicts, and exact apply plan.

### 20.14 `patchbay_apply`

**Safety:** consequential write; must require prompt approval by default.  
**Input:** job ID, expected task hash, expected patch hash, expected base commit, target repository, and prepare token.  
**Output:** apply result, resulting tree hash, changed files, and receipt update.

### 20.15 `patchbay_receipts`

**Safety:** read-only.  
**Input:** repository/profile/date filters and limit.  
**Output:** summarized receipts and aggregate verified-cost metrics.

---

## 21. Job state machine

### 21.1 Main states

```text
CREATED
  → VALIDATED
  → SNAPSHOTTED
  → WORKTREE_READY
  → QUEUED
  → RUNNING_WORKER
  → PATCH_READY
  → POLICY_CHECK
  → VERIFYING
  → VERIFIED
  → REVIEWING          optional
  → REVIEWED
  → READY_TO_APPLY
  → APPLIED
```

### 21.2 Repair branch

```text
VERIFIED / REVIEWED
  → CHANGES_REQUESTED
  → REPAIR_QUEUED
  → RUNNING_REPAIR
  → PATCH_READY
  → POLICY_CHECK
  → VERIFYING
  → REVIEWING          when required
```

### 21.3 Exceptional and terminal states

```text
FAILED_WORKER
FAILED_POLICY
FAILED_VERIFICATION
FAILED_REVIEW
BUDGET_EXCEEDED
CANCEL_REQUESTED
CANCELLED
STALE
NEEDS_CODEX
NEEDS_HUMAN
ENVIRONMENT_FAILURE
APPLIED
ARCHIVED
```

### 21.4 Transition requirements

- Transitions use compare-and-set semantics with expected prior states.
- Every transition appends an immutable event.
- Terminal transitions clear active process ownership.
- Cancellation and worker completion races must resolve deterministically.
- A completed worker process does not imply `VERIFIED`.
- `READY_TO_APPLY` requires successful policy and verification plus satisfaction of configured review policy.
- `APPLIED` requires an approved apply operation with matching hashes.

---

## 22. Persistence model

### 22.1 Tables

#### `repositories`

- `id`
- canonical path hash
- Git common-dir identity
- created/last-seen timestamps

#### `jobs`

- job ID
- repository ID
- parent job ID
- owner Codex session
- task hash
- base commit
- worker profile
- risk class
- current state and phase
- process PID and process identity
- heartbeat
- isolation mode
- created/started/completed timestamps
- terminal reason

#### `events`

- monotonically ordered event ID
- job ID
- prior state
- new state
- event type
- redacted payload
- timestamp

#### `artifacts`

- artifact ID
- job ID
- type
- content hash
- relative storage path
- media type
- byte length
- redaction status
- retention class

#### `checks`

- job ID
- check ID
- argv hash
- exit code
- timeout flag
- start/end/duration
- stdout/stderr artifact IDs
- result classification

#### `reviews`

- review ID
- job ID
- profile
- mode
- prompt hash
- raw output artifact
- parsed output artifact
- parse status
- cost/usage
- review hash

#### `findings`

- finding ID
- review ID
- severity
- file/symbol/line
- claim and evidence
- confidence
- Codex disposition
- disposition reason

#### `receipts`

- receipt ID
- job ID
- canonical receipt JSON
- receipt hash
- final disposition

#### `leases`

- resource key
- owner process identity
- expiry/heartbeat
- purpose

### 22.2 Storage requirements

- Database and artifacts live under the Codex-provided plugin data directory.
- File permissions are private to the current user.
- Database migrations are forward-only and transactional.
- Corruption produces a safe degraded mode; Patchbay must never apply a patch when authoritative state cannot be established.
- Large artifacts are stored as files referenced by hash, not database blobs.
- Retention defaults are configurable; receipts may outlive raw logs.

---

## 23. Git and integration design

### 23.1 Repository identity

Repository identity combines:

- canonical Git common directory;
- repository path hash;
- initial remote fingerprint when available;
- filesystem identity where supported.

Do not trust a user-supplied path alone.

### 23.2 Dirty working tree policy

Default write-delegation policy is `reject` when the active checkout has uncommitted tracked or untracked changes. Future modes may snapshot a diff explicitly, but version 0.1 avoids ambiguous bases.

Read-only review may target the active working tree, but the UI must clearly disclose that it is not isolated by a detached worktree.

### 23.3 Candidate worktree

- Detached at exact base commit.
- Never checks out the user’s branch by name.
- Has no configured push credentials.
- Worker may not commit.
- Candidate patch is generated relative to the base commit.

### 23.4 Verifier worktree

- Fresh detached worktree at the same base.
- Candidate patch applied from stored artifact.
- No provider credentials.
- Verification uses the resulting files, not state from the worker worktree.

### 23.5 Stale candidate handling

When the target HEAD differs from the candidate base:

1. mark candidate `STALE` for direct apply;
2. create an integration worktree at current target HEAD;
3. attempt a three-way patch application;
4. if conflicts occur, transition to `NEEDS_CODEX`;
5. if application succeeds, rerun policy checks and all required acceptance commands;
6. issue a new integration verification receipt and patch hash;
7. require a fresh apply preparation and approval.

### 23.6 Apply semantics

- Apply exact content only.
- Do not commit.
- Do not stage unless the user explicitly chooses a future opt-in setting.
- Verify resulting tree/diff against the prepared artifact.
- Roll back partial application on failure.
- Serialize apply operations per repository.

---

## 24. Verification pipeline

```text
Worker exits
   ↓
Inventory all changes
   ↓
Path and artifact policy checks
   ↓
Canonical patch + hash
   ↓
Fresh verifier worktree at exact base
   ↓
Apply candidate patch
   ↓
Re-run policy checks
   ↓
Run acceptance commands in order
   ↓
Capture evidence and classify failure
   ↓
Optional Claude review
   ↓
Codex judgment
```

### 24.1 Check result classifications

- `passed`
- `test_failed`
- `lint_failed`
- `type_failed`
- `build_failed`
- `timeout`
- `command_not_found`
- `dependency_environment_failure`
- `sandbox_failure`
- `cancelled`
- `policy_rejected`

Environment failures must not be reported as code failures, and code failures must not be hidden behind generic runtime errors.

### 24.2 Command execution requirements

- Spawn executable and argv directly.
- Validate executable against repository/managed policy.
- Resolve `cwd` within verifier root.
- Set minimal environment.
- Use bounded stdout and stderr with full spillover artifacts where permitted.
- Kill the complete process tree on timeout.
- Record executable resolution and version when practical.
- Disable network unless the contract and managed policy permit it.

### 24.3 Acceptance rule

A task is mechanically verified only when:

- all required policy checks pass;
- every required command exits successfully;
- no timeout or environment uncertainty remains;
- the patch hash and base commit match the verification receipt.

Optional checks may fail without blocking only when the contract declares them optional and Codex explicitly considers the evidence.

---

## 25. Review system

### 25.1 Review trigger policy

Claude review is required by default when any of these are true:

- risk is high;
- authentication, authorization, payments, secrets, or permissions changed;
- database schema, migration, data retention, or deletion changed;
- concurrency, retries, idempotency, rollback, or distributed state changed;
- cryptography or security boundaries changed;
- public API semantics changed;
- candidate exceeds configurable size thresholds;
- worker needed a repair pass;
- deterministic coverage is weak;
- Codex or the user explicitly requests review.

Review is normally skipped for:

- documentation-only changes;
- formatting;
- mechanical generated-code updates;
- narrowly scoped test additions;
- changes below configured risk and size thresholds.

### 25.2 Review prompt contract

Claude receives:

- objective and non-goals;
- exact candidate diff;
- relevant repository instructions;
- changed-file context;
- verification commands and outcomes;
- explicit review mode;
- strict finding schema;
- instruction to report no finding when evidence is insufficient.

Claude does not receive worker self-evaluation or unrelated conversation history.

### 25.3 Finding schema

```json
{
  "verdict": "changes_requested",
  "findings": [
    {
      "id": "R-001",
      "severity": "high",
      "category": "correctness",
      "file": "src/invitations/validate.ts",
      "line": 81,
      "symbol": "validateInvitation",
      "claim": "An invitation remains valid at the exact expiry boundary.",
      "evidence": "The comparison uses `<` rather than `<=`.",
      "reproduction": "Set expiresAt equal to the injected current time.",
      "suggested_check": "Add a test where now equals expiresAt.",
      "confidence": 0.91
    }
  ],
  "uncertainties": []
}
```

### 25.4 No silent approval on parse failure

If structured output cannot be parsed or validated, review state becomes `FAILED_REVIEW` or `NEEDS_CODEX`; it is never interpreted as “no findings.”

---

## 26. Routing policy

### 26.1 Version 0.1: explicit/manual

Codex or the user selects a named healthy profile. Patchbay validates suitability and limits but does not choose autonomously.

### 26.2 Version 0.2: deterministic recommendation

Patchbay recommends a profile based on:

- task risk;
- expected file count and diff size;
- language/framework capability;
- worker health;
- quota availability;
- configured user preference;
- requirement for structured output or command permissions.

### 26.3 Version 1: evidence-based routing

Historical outcomes may influence recommendation:

- verified pass at first attempt;
- cost per verified candidate;
- median time to verified candidate;
- repair rate;
- scope-violation rate;
- reviewer-confirmed defect rate;
- post-application rollback rate;
- repository and task-class affinity.

The routing model must be explainable. Every recommendation includes a reason and the user can override it.

### 26.4 Default risk matrix

| Task class | Default owner | Cheap-worker use | Claude review |
|---|---|---|---|
| Docs and comments | DeepSeek/GLM | Full bounded task | No |
| Tests and fixtures | DeepSeek/GLM | Full bounded task | Usually no |
| Mechanical refactor | DeepSeek/GLM | Full bounded task | Conditional |
| Bounded bug fix | Capable DeepSeek/GLM | Full bounded task | Conditional |
| Feature with public API change | Codex plans; worker implements | Yes, constrained | Yes |
| Auth/permissions | Codex | Narrow subtasks only | Required |
| Payments/financial logic | Codex | Tests/research only by default | Required |
| Migration/data deletion | Codex | Narrow subtasks only | Required |
| Cryptography/secrets | Codex | Read-only research only | Required |
| Infrastructure/deployment | Codex | Narrow non-destructive subtasks | Required |

---

## 27. Security and threat model

### 27.1 Protected assets

- repository source and history;
- active working tree;
- provider credentials;
- Git and package publishing credentials;
- cloud credentials;
- private prompts and task context;
- verification evidence;
- job and receipt integrity;
- user compute and subscription quota.

### 27.2 Trust boundaries

1. User ↔ Codex.
2. Codex ↔ Patchbay MCP server.
3. Patchbay ↔ external coding harness.
4. Harness ↔ model provider.
5. Worker process ↔ isolated worktree.
6. Reviewer ↔ read-only candidate.
7. Patchbay ↔ active checkout.
8. Plugin package ↔ local runtime.

### 27.3 Threats and mitigations

#### T-01: Prompt injection in repository content

**Risk:** Source comments or files instruct a worker to ignore scope, leak secrets, or invoke tools.  
**Mitigations:** deny-first harness permissions; no unrelated credentials; network off; post-run path checks; worker output treated as untrusted; no recursive delegation.

#### T-02: Worker edits forbidden files

**Risk:** Model ignores instructions or uses shell writes.  
**Mitigations:** isolated worktree; path-scoped editing where supported; full Git inventory; realpath checks; reject candidate before verification.

#### T-03: Shell escape or command injection

**Risk:** Contract strings become shell syntax.  
**Mitigations:** argv arrays; no shell by default; executable allowlists; restricted working directory; container secure mode; command audit log.

#### T-04: Credential leakage

**Risk:** Worker reads environment, home config, SSH agent, or cloud files.  
**Mitigations:** temporary HOME; environment allowlist; no SSH agent socket; no Git credential helper; selected provider credential only; log redaction; network disabled when possible.

#### T-05: Symlink/path traversal

**Risk:** Allowed-path edit reaches outside repository.  
**Mitigations:** reject absolute and parent paths; lstat/realpath validation; reject new symlinks by default; container mount boundaries; post-run inode/path checks.

#### T-06: Stale patch application

**Risk:** Green patch from old base is applied after branch changes.  
**Mitigations:** bind base SHA and patch hash; prepare token; stale state; fresh integration verification.

#### T-07: Process PID reuse

**Risk:** Cancellation kills an unrelated process.  
**Mitigations:** store process start identity, command fingerprint, and parent relationship; compare before termination; use process groups/container IDs.

#### T-08: Recursive agent fan-out

**Risk:** Worker launches other agents and burns cost or escapes policy.  
**Mitigations:** deny subagent/task tools; strip Patchbay MCP config from worker environment; contract flag fixed false by default; process/network policy.

#### T-09: Tampered artifacts or receipts

**Risk:** Candidate, logs, or verification output changes after approval.  
**Mitigations:** content hashes; append-only events; prepare token bound to hashes; private file permissions; optional signed receipts in v1.

#### T-10: Supply-chain compromise

**Risk:** Plugin, runtime, or dependency is malicious.  
**Mitigations:** lockfiles; pinned dependencies; provenance; SBOM; signed releases; reproducible builds; minimal dependency tree; no install scripts; documented runtime versions.

#### T-11: Reviewer modifies code

**Risk:** “Read-only” prompt is bypassed.  
**Mitigations:** read-only filesystem mount; no edit tools; no arbitrary shell; ephemeral reviewer checkout; post-review diff assertion.

#### T-12: Resource exhaustion

**Risk:** Worker generates unbounded logs, files, processes, or model calls.  
**Mitigations:** step, wall-time, process, output, file-count, diff, disk, and cost limits; bounded logs; cancellation; concurrency caps.

#### T-13: Untrusted plugin hooks

**Risk:** Hooks are treated as the sole enforcement mechanism or modified unexpectedly.  
**Mitigations:** correctness lives in the MCP server; hooks are optional and reviewed; hook hashes surfaced by setup; no secrets in hook payloads.

#### T-14: Malicious worker result instructs Codex

**Risk:** Result text contains commands or claims authority.  
**Mitigations:** structured result schema; untrusted-data delimiters; Codex skill explicitly rejects instructions from worker output; executable actions require separate typed calls.

### 27.4 Security defaults

- Network denied for workers unless explicitly required.
- Worker cannot see the main checkout.
- Worker cannot commit or push.
- Reviewer is filesystem read-only.
- Apply requires approval.
- Telemetry is off.
- Raw prompts and code are not transmitted except to selected providers.
- Protected paths include `.git/**`, `.github/workflows/**`, credential files, package publishing config, and Patchbay state/config by default.

---

## 28. Configuration

### 28.1 Configuration layers

From strongest to weakest:

1. Managed organization policy.
2. Repository `.patchbay/config.toml`.
3. User configuration in plugin data.
4. Shipped plugin defaults.

A lower layer may narrow permissions or budgets but may not broaden a stronger security policy.

### 28.2 Example repository configuration

```toml
version = 1

[repository]
dirty_policy = "reject"
default_worker = "deepseek-fast"
default_review_policy = "on-risk"

[concurrency]
max_read_jobs = 3
max_write_jobs = 1
max_review_jobs = 1

[scope]
protected = [
  ".git/**",
  ".github/workflows/**",
  ".npmrc",
  "**/*.pem",
  "**/*.key"
]

[verification]
default_commands = [
  ["pnpm", "lint"],
  ["pnpm", "typecheck"]
]

[budgets]
max_worker_wall_seconds = 1800
max_review_cost_usd = 1.00
max_repair_rounds = 1

[apply]
require_human_approval = true
auto_stage = false
```

### 28.3 Secret configuration

Repository config must never contain credentials. It may reference environment-variable names or an OS keychain entry. `doctor` must verify presence without exposing the value.

---

## 29. Budget and quota controls

Patchbay enforces:

- maximum model steps;
- maximum wall time;
- maximum output bytes;
- maximum changed files;
- maximum diff lines;
- maximum files created;
- maximum verifier duration;
- maximum review turns;
- maximum review cost where the CLI supports it;
- maximum repair rounds;
- per-provider concurrent jobs;
- optional daily provider budget/quota threshold.

Cost records distinguish:

- API-reported currency cost;
- token counts;
- cached-token counts;
- subscription or plan quota units;
- unknown/unreported usage.

Patchbay must not fabricate dollar estimates when provider pricing or subscription accounting is unavailable. Optional estimates are labeled clearly and use versioned pricing configuration.

---

## 30. Logging, artifacts, privacy, and telemetry

### 30.1 Logging

- Structured JSON events internally.
- Human-readable bounded job log.
- Secret redaction before persistence.
- Maximum default active log size per job.
- Large outputs stored as hashed artifacts with retention controls.
- No hidden reasoning storage.

### 30.2 Privacy

By default Patchbay stores locally:

- task contract;
- context bundle;
- worker raw and parsed result;
- patch;
- verification output;
- reviewer output;
- receipts.

Users may configure shorter retention or disable raw model output retention after receipt generation.

### 30.3 Telemetry

Telemetry is disabled by default. An opt-in anonymous mode may collect only:

- plugin version;
- platform class;
- runtime adapter class;
- task risk class;
- terminal state;
- durations and coarse numeric counts;
- error category.

It must never collect:

- code;
- prompts;
- diffs;
- file paths;
- repository names or remotes;
- credentials;
- model output;
- command stdout/stderr.

---

## 31. Error handling and recovery

### 31.1 Error taxonomy

- `configuration_error`
- `runtime_missing`
- `authentication_error`
- `provider_unavailable`
- `quota_exhausted`
- `worker_timeout`
- `worker_failed`
- `structured_output_error`
- `scope_violation`
- `artifact_policy_violation`
- `verification_failed`
- `verification_environment_failure`
- `review_failed`
- `review_parse_failed`
- `cancelled`
- `state_conflict`
- `stale_base`
- `apply_conflict`
- `storage_error`
- `sandbox_error`
- `internal_error`

### 31.2 Recovery rules

- Provider transient retries: at most one automatic retry with jitter, only before code changes are accepted.
- Worker retry never silently changes provider or model; Codex must authorize a route change.
- Verification environment failure may be retried without consuming a repair round.
- Code verification failure may trigger one repair round.
- Review parse failure may retry once with a stricter prompt under the same budget.
- State conflicts fail closed.
- Storage corruption blocks apply.
- Orphaned worktrees are quarantined before cleanup when ownership is uncertain.

### 31.3 Cancellation

Cancellation is cooperative first, then forceful:

1. transition to `CANCEL_REQUESTED`;
2. signal the exact process group/container;
3. wait a bounded grace period;
4. force terminate;
5. capture partial logs and candidate state;
6. transition to `CANCELLED` or `NEEDS_HUMAN` if termination cannot be proven.

---

## 32. Functional requirements

### Plugin and setup

- **FR-001:** The project shall install as a Codex plugin with the `patchbay` namespace.
- **FR-002:** The plugin shall bundle discoverable setup, orchestration, delegation, review, status, result, cancel, and receipt skills.
- **FR-003:** The plugin shall register a local STDIO MCP server.
- **FR-004:** The distributed package shall include prebuilt runtime files and shall not require npm lifecycle scripts.
- **FR-005:** Setup shall disclose required local tools, provider connections, writable locations, and optional hooks.
- **FR-006:** Doctor shall report readiness without revealing credential values.

### Contracts and jobs

- **FR-010:** Every write job shall require a schema-valid task contract.
- **FR-011:** Patchbay shall canonicalize and hash the contract before execution.
- **FR-012:** Patchbay shall bind each job to repository identity, base commit, and Codex session.
- **FR-013:** Patchbay shall support background execution, status, bounded logs, results, and cancellation.
- **FR-014:** State transitions shall be atomic and append an immutable event.
- **FR-015:** Patchbay shall recover or safely classify nonterminal jobs after process restart.

### Workers

- **FR-020:** Patchbay shall support DeepSeek through an OpenCode adapter.
- **FR-021:** Patchbay shall support GLM through an OpenCode adapter.
- **FR-022:** Worker profiles shall resolve model IDs from configuration rather than source constants.
- **FR-023:** Write workers shall run in isolated detached worktrees.
- **FR-024:** Worker environments shall contain only the selected provider credentials and approved variables.
- **FR-025:** Workers shall be denied recursive Patchbay delegation by default.
- **FR-026:** Workers shall not commit, push, merge, publish, or deploy.

### Policy and verification

- **FR-030:** Patchbay shall inventory every file-system change relative to the base commit.
- **FR-031:** Patchbay shall reject forbidden-path and protected-path changes.
- **FR-032:** Patchbay shall enforce file-count, diff-size, binary, symlink, lockfile, and mode-change policy.
- **FR-033:** Patchbay shall generate and hash a canonical patch.
- **FR-034:** Patchbay shall verify the candidate in a separate clean worktree.
- **FR-035:** Verification commands shall be executed as executable/argv arrays without a shell by default.
- **FR-036:** Patchbay shall capture bounded, hashed evidence for every check.
- **FR-037:** Worker self-reported tests shall not satisfy acceptance requirements.

### Review and repair

- **FR-040:** Patchbay shall support Claude Code read-only reviews.
- **FR-041:** Review output shall conform to a versioned finding schema.
- **FR-042:** Parse failure shall never be treated as approval.
- **FR-043:** Codex shall submit a disposition for each reviewer finding before an automatic repair job is created.
- **FR-044:** Automatic repair shall be bounded to the configured maximum, one by default.
- **FR-045:** Repaired candidates shall repeat policy and deterministic verification.

### Integration

- **FR-050:** Prepare-apply shall verify repository, base, task hash, patch hash, receipt, and current checkout state.
- **FR-051:** Apply shall require explicit approval by default.
- **FR-052:** Apply shall not commit, push, merge, publish, or deploy.
- **FR-053:** Stale candidates shall require integration on the new base and fresh verification.
- **FR-054:** Patchbay shall record resulting tree state and final disposition.

### Receipts and metrics

- **FR-060:** Every terminal job shall produce a canonical receipt.
- **FR-061:** Receipts shall include actual isolation level, worker, usage, patch statistics, checks, review, repair, and disposition.
- **FR-062:** Artifacts and receipts shall be content-hashed.
- **FR-063:** Users shall be able to query recent receipts and aggregate local metrics.

---

## 33. Non-functional requirements

### Security

- **NFR-001:** The product shall fail closed on ambiguous repository identity, state corruption, hash mismatch, or policy uncertainty.
- **NFR-002:** Secrets shall not appear in normal logs, receipts, or MCP responses.
- **NFR-003:** Secure mode shall provide an operating-system isolation boundary, not merely a Git worktree.
- **NFR-004:** No model shall receive unrelated provider or infrastructure credentials.
- **NFR-005:** Consequential apply shall require a typed, approved MCP operation.

### Reliability

- **NFR-010:** Job completion/cancellation races shall not produce multiple terminal transitions.
- **NFR-011:** Crash recovery shall not kill an unrelated process due to PID reuse.
- **NFR-012:** All worktree cleanup shall be ownership-checked and idempotent.
- **NFR-013:** A failed cleanup shall not conceal the candidate or verification result.

### Performance

- **NFR-020:** Read-only MCP status calls should return without starting provider processes.
- **NFR-021:** Worktree creation and patch policy analysis should add minimal overhead relative to model execution.
- **NFR-022:** Large logs and diffs shall be paged or referenced as artifacts rather than injected wholesale into Codex context.

### Portability

- **NFR-030:** Version 0.1 shall support macOS, Linux, and Windows through WSL2.
- **NFR-031:** Container secure mode shall support Docker-compatible engines first, with adapter boundaries for alternatives.
- **NFR-032:** Native dependencies requiring local compilation shall be avoided.

### Compatibility

- **NFR-040:** Patchbay shall use semantic versioning.
- **NFR-041:** Task, result, review, receipt, and adapter schemas shall be versioned independently.
- **NFR-042:** CI shall test the current supported Codex release and at least one prior compatible minor release.
- **NFR-043:** Runtime doctor checks shall surface unsupported OpenCode or Claude Code versions before execution.

### Privacy and usability

- **NFR-050:** Telemetry shall be opt-in.
- **NFR-051:** User-facing errors shall name the failed phase, preserve evidence, and suggest a bounded recovery action.
- **NFR-052:** The plugin shall clearly distinguish worker claims, deterministic evidence, Claude findings, Codex judgment, and user approval.

---

## 34. Test strategy

### 34.1 Unit tests

Cover:

- schema validation and canonicalization;
- path normalization and escape rejection;
- command argv validation;
- state transition rules;
- cost/quota accounting;
- redaction;
- artifact hashing;
- profile merging and precedence;
- review parsing and finding validation;
- stale-base logic.

### 34.2 Runtime contract tests

Every adapter must pass a shared suite:

- doctor result;
- successful read job;
- successful write job;
- structured event parsing;
- timeout;
- cancellation;
- malformed output;
- usage reporting;
- denied permission behavior;
- process-tree cleanup.

Use fake provider executables in normal CI.

### 34.3 Git integration tests

Cover:

- detached worktree lifecycle;
- untracked file handling;
- symlink and submodule policy;
- binary changes;
- dirty checkout rejection;
- patch extraction and clean reapplication;
- stale-base integration;
- conflict handling;
- cleanup after crash simulation.

### 34.4 MCP contract tests

- strict input schemas;
- unknown field rejection;
- approval-sensitive tool labeling;
- pagination and bounded responses;
- cross-session ownership;
- prepare/apply token replay prevention;
- hash mismatch behavior.

### 34.5 Security/adversarial tests

Seed repositories with instructions attempting to:

- read `~/.ssh`;
- print environment variables;
- write outside allowed paths;
- create symlink escapes;
- invoke `git push`;
- start recursive agents;
- modify `.github/workflows`;
- hide changes in untracked or binary files;
- inject shell syntax through task fields;
- manipulate reviewer output;
- cause enormous logs or files.

Expected result: the worker may attempt the action, but policy or isolation prevents acceptance and produces an explicit receipt.

### 34.6 Fault-injection tests

Simulate:

- server crash at each state transition;
- worker completion during cancellation;
- verifier timeout;
- disk full;
- corrupted job record;
- database lock/contention;
- provider quota exhaustion;
- process PID reuse;
- worktree add/remove partial failures;
- active branch moving before apply.

### 34.7 Real-provider smoke tests

Opt-in, secret-gated CI or maintainer runs:

- one minimal DeepSeek task;
- one minimal GLM task;
- one Claude review;
- provider authentication and current model resolution;
- structured output compatibility.

Real-provider tests must have hard cost and turn limits.

### 34.8 End-to-end acceptance scenarios

1. DeepSeek creates an allowed test file, clean verifier passes, user applies.
2. GLM changes a forbidden file, candidate is rejected before tests.
3. Worker claims tests pass but verifier fails; Codex sees the discrepancy.
4. Claude reports one valid and one false finding; Codex dispositions are recorded and only the valid finding reaches repair.
5. Active branch moves after verification; direct apply is blocked and integration is re-verified.
6. Cancellation races worker completion; exactly one terminal state results.
7. Plugin restarts during execution; job is recovered without killing an unrelated process.
8. Worker attempts credential exfiltration; secure mode prevents access/network and logs contain no secret.

---

## 35. Evaluation and success metrics

### 35.1 Product-level success metrics

- Setup success rate on supported environments.
- Percentage of eligible jobs reaching a terminal receipt.
- Zero accepted protected-path violations.
- Zero automatic pushes, merges, releases, or deployments.
- Verified pass rate at first candidate.
- Median repair rounds per accepted task.
- Time to verified candidate.
- Cost or quota per verified candidate.
- Percentage of Claude findings confirmed by Codex.
- Stale candidate block rate and safe reintegration rate.
- Crash recovery success rate.

### 35.2 Economic target

On a maintained benchmark of delegable repository tasks, Patchbay should reduce orchestrator-model implementation usage by at least 50 percent compared with a Codex-only workflow while maintaining comparable verified acceptance and regression outcomes. This is a target to measure, not a launch claim.

### 35.3 Reviewer quality metrics

- finding precision: confirmed findings / total findings;
- high-severity precision;
- defect discovery beyond deterministic tests;
- false-positive cost;
- percentage of reviews producing no actionable findings;
- repair success for confirmed findings.

### 35.4 Benchmark design

Maintain seeded tasks covering:

- documentation;
- mechanical refactor;
- test generation;
- bounded bug fix;
- parser or data transformation;
- API behavior;
- concurrency defect;
- authorization defect.

Each task includes a hidden or independent acceptance harness. Compare providers using verified outcomes rather than self-reported completion.

---

## 36. Delivery milestones and exit criteria

No milestone is considered complete merely because the model adapter can produce text. Each milestone ends with executable acceptance criteria.

### Milestone 0: Foundation and public specification

Deliverables:

- repository, license, governance, and contribution documents;
- plugin manifest and empty namespaced skills;
- architecture decision records;
- schemas v1 drafts;
- threat model;
- fake runtime testkit;
- CI, lint, typecheck, unit-test, and release skeleton.

Exit criteria:

- plugin is discoverable by Codex;
- bundled MCP server answers `doctor` using fake/no-provider mode;
- release package contains prebuilt runtime and no required lifecycle script.

### Milestone 1: Single verified DeepSeek worker

Deliverables:

- OpenCode adapter;
- DeepSeek profile;
- contract validator;
- job state manager;
- isolated worktree manager;
- candidate policy gate;
- clean verifier;
- status/result/cancel tools;
- manual apply guard;
- receipts.

Exit criteria:

- all version 0.1 end-to-end scenarios for one worker pass;
- a worker cannot produce an accepted forbidden-path change;
- a false test claim is exposed by clean verification;
- apply requires matching hashes and approval.

### Milestone 2: GLM and Claude review

Deliverables:

- GLM profiles;
- provider health and model resolution;
- Claude Code read-only adapter;
- review schema;
- Codex finding-disposition flow;
- one repair round;
- review-cost limits.

Exit criteria:

- DeepSeek and GLM pass adapter conformance tests;
- Claude cannot modify reviewer checkout;
- parse failure does not approve a patch;
- confirmed-only repair flow works end to end.

### Milestone 3: Hardening and recovery

Deliverables:

- secure container execution;
- credential broker;
- robust process identity;
- crash recovery;
- stale worktree cleanup;
- security regression suite;
- signed artifacts and SBOM.

Exit criteria:

- adversarial credential, path, symlink, recursive-agent, and resource-exhaustion tests pass;
- crash/fault injection produces safe terminal states;
- no known path to automatic push or merge exists.

### Milestone 4: Routing and beta

Deliverables:

- deterministic route recommendation;
- local metrics and provider scoreboard;
- benchmark suite;
- compatibility matrix;
- migration docs;
- marketplace-ready assets and documentation.

Exit criteria:

- recommendations include human-readable rationale;
- routing never bypasses managed risk policy;
- beta benchmark and security report are published.

### Milestone 5: Version 1.0

Deliverables:

- stable adapter SDK;
- evidence-based optional routing;
- mature cross-platform support matrix;
- signed reproducible releases;
- complete operations and troubleshooting guides;
- security disclosure process.

Exit criteria:

- all functional and non-functional launch requirements pass;
- no unresolved critical/high security issue;
- public API and schema stability policy is documented;
- maintainers have completed release and recovery drills.

---

## 37. Engineering epics and issue breakdown

### Epic A: Plugin shell

- Create manifest and interface metadata.
- Implement all skill stubs.
- Register bundled MCP server.
- Add setup and optional hook trust flow.
- Build release artifact without lifecycle scripts.

### Epic B: Schemas and core domain

- Define task, worker result, verification, review, and receipt schemas.
- Implement canonical JSON and hashing.
- Define error taxonomy and result types.
- Build configuration and profile precedence.

### Epic C: Persistence and job lifecycle

- Select portable SQLite implementation.
- Implement migrations and repositories/jobs/events/artifacts tables.
- Add compare-and-set transitions.
- Add session ownership, leases, heartbeats, and recovery.
- Implement bounded logs and artifact retention.

### Epic D: Git isolation

- Resolve repository identity and exact base.
- Enforce dirty-tree policy.
- Create/remove detached worktrees.
- Inventory all changes.
- Extract canonical patches.
- Implement stale-base and integration handling.

### Epic E: Worker runtimes

- Implement runtime interface.
- Build fake runtime.
- Build OpenCode adapter.
- Add DeepSeek profile.
- Add GLM profile.
- Add provider health/model resolution.

### Epic F: Sandbox and credentials

- Implement environment allowlist and temporary HOME.
- Remove SSH/Git/cloud/package credentials.
- Build container runner.
- Add network policy.
- Add disk/process/output limits.
- Add secret redaction.

### Epic G: Policy and verification

- Build path and artifact policy engine.
- Add symlink, binary, file mode, lockfile, and secret checks.
- Build verifier worktree and command runner.
- Add evidence artifacts and result classification.

### Epic H: Claude review and repair

- Build Claude CLI adapter.
- Create review modes and schema.
- Implement parse/validation behavior.
- Add finding disposition tool.
- Add bounded repair child jobs.

### Epic I: Safe application

- Implement prepare token.
- Bind base/task/patch/receipt hashes.
- Add explicit approval requirements.
- Apply exact patch transactionally.
- Record resulting tree and disposition.

### Epic J: Observability and evaluation

- Generate receipts.
- Implement receipts query and summaries.
- Add local provider metrics.
- Build seeded eval harness.
- Add opt-in telemetry with privacy tests.

### Epic K: Documentation and community

- README and quickstart.
- Provider setup guides.
- Security and threat-model docs.
- Extension SDK guide.
- Contributing, DCO, governance, and code of conduct.
- Marketplace listing and screenshots.

---

## 38. Open-source governance

### 38.1 License

Recommend Apache-2.0 for an explicit patent grant and broad commercial/open-source use. All source files should carry SPDX identifiers.

### 38.2 Contributions

Use Developer Certificate of Origin sign-off rather than requiring a bespoke contributor license agreement initially. Require:

- tests for behavior changes;
- threat-model notes for new permissions or runtimes;
- compatibility notes for provider changes;
- no undocumented telemetry;
- no new install scripts without security review.

### 38.3 Provider neutrality

The project must not make one model provider a privileged hidden dependency. Built-in profiles can be opinionated, but the adapter API, receipts, and routing metrics must remain provider-neutral.

### 38.4 Security process

Publish `SECURITY.md` with a private reporting path, supported-version policy, response process, and disclosure expectations. Critical apply, credential, or sandbox vulnerabilities should receive coordinated fixes and signed releases.

### 38.5 Release integrity

- signed Git tags;
- provenance attestations;
- SBOM;
- checksums;
- reproducible build instructions;
- immutable release artifacts;
- changelog with schema/config migrations.

---

## 39. Compatibility policy

### 39.1 Codex

Support a documented range rather than “latest only.” CI tests the newest supported Codex release and the previous compatible minor. Breaking host changes trigger a compatibility release, not silent degradation.

### 39.2 OpenCode and Claude Code

`doctor` checks minimum and tested versions. The project maintains a machine-readable compatibility matrix. Unsupported versions fail before a consequential job begins unless the user enters explicit unsafe development mode.

### 39.3 Provider models

Profiles may carry recommended aliases, but model IDs are resolved from user/config/provider capabilities. Deprecation warnings are surfaced by `doctor`. Receipts always record the resolved model used.

### 39.4 Schemas and adapters

- Semantic versioning for packages.
- Explicit schema version in every durable artifact.
- Adapter API compatibility documented separately.
- Migrations preserve readable historical receipts.

---

## 40. Product decisions and rationale

### Why not make Claude the orchestrator?

The product requirement is that Codex owns the user thread, task decomposition, worker choice, finding validation, and final AI judgment. Claude is intentionally an independent reviewer to reduce correlated mistakes and prevent authority ambiguity.

### Why not let DeepSeek or GLM call tools directly through a minimal API loop?

That would require rebuilding file editing, command permissions, context management, structured events, cancellation, and provider-specific tool-use details. OpenCode is the pragmatic first harness; direct adapters can be added after measured need.

### Why not trust the worker’s tests?

The worker environment may contain untracked state, altered dependencies, generated files, running services, or accidental contamination. Clean verification converts claims into reproducible evidence.

### Why review only after tests?

Claude review is comparatively costly. Objective failures should be fixed before paying for semantic review, unless the reviewer is being used diagnostically.

### Why not use hooks as the security gate?

Hooks are useful for UX and secondary guardrails but may not cover every specialized execution path. Security and state enforcement belong in the control plane and operating-system boundary.

### Why no automatic merge?

The first stable release should establish trust through explicit human authorization. Automatic low-risk application can be considered later as an opt-in policy after sufficient local evidence.

### Why no general swarm?

Write-heavy parallelism creates conflicts, unclear authority, duplicated cost, and difficult recovery. Patchbay focuses on bounded jobs, read-only parallelism, and serialized integration.

---

## 41. Open questions and deferred decisions

1. Which portable SQLite implementation best satisfies cross-platform distribution without install scripts?
2. Does the Codex plugin runtime reliably expose a plugin-root variable to bundled MCP command arguments on every supported host, or should the MCP server be shipped as a separate pinned executable package?
3. Which container engine abstraction gives the best macOS/Linux/WSL2 experience?
4. How should Coding Plan quota be represented when providers do not expose per-job monetary cost?
5. Should secure mode support a local credential proxy in version 1.0 or later?
6. What repository classes require network access for dependency installation, and how should lockfile/cache policy handle them?
7. Should working-tree review be supported when uncommitted changes contain secrets or very large generated files?
8. Which protected-path defaults are language-agnostic enough to ship globally?
9. When should evidence-based routing graduate from recommendation to automatic selection?
10. Should signed receipts use a per-installation key stored in the OS keychain?
11. What minimum Codex version should the first marketplace release declare after the implementation spike?
12. Should the npm package remain unscoped as `codex-patchbay`, or use the maintainer’s personal npm scope?

---

## 42. Version 0.1 definition of done

Version 0.1 is complete only when all of the following are true:

1. A user can install the plugin and run setup/doctor from Codex.
2. Codex can create a valid contract and delegate it to a DeepSeek OpenCode worker.
3. The worker runs in a detached worktree and cannot alter the active checkout.
4. Patchbay detects every changed and untracked file.
5. A forbidden-path modification is rejected.
6. A canonical patch and hash are produced.
7. The patch is applied to a new verifier worktree.
8. Required commands run with bounded output and timeouts.
9. A failing clean check prevents `READY_TO_APPLY` even if the worker claimed success.
10. Status, result, logs, and cancellation work for background jobs.
11. State survives control-plane restart.
12. Apply requires a matching base, task hash, patch hash, verification receipt, prepare token, and user approval.
13. Patchbay does not commit, push, merge, publish, or deploy.
14. A complete receipt is generated.
15. Unit, integration, adversarial, and fault-injection acceptance suites pass on supported platforms.

---

## 43. Version 1.0 definition of done

Version 1.0 additionally requires:

1. DeepSeek and GLM worker profiles pass runtime conformance.
2. Claude Code review is read-only and schema-constrained.
3. Codex finding dispositions and one repair round work end to end.
4. Secure container mode is available on all supported platform classes.
5. Credential isolation and redaction pass adversarial tests.
6. Stale-base reintegration and re-verification are reliable.
7. Crash recovery and process identity protections pass fault injection.
8. Deterministic route recommendations are explainable and policy-safe.
9. Signed releases, provenance, SBOM, compatibility matrix, and security process are public.
10. The adapter SDK is documented and at least one external sample adapter passes conformance.
11. No unresolved critical or high-severity security issue remains.
12. The public benchmark reports verified quality, cost/quota, time, and reviewer precision without overstating results.

---

## 44. Illustrative plugin manifest

```json
{
  "name": "patchbay",
  "version": "0.1.0",
  "description": "Codex-led, evidence-gated delegation to lower-cost coding workers and independent reviewers.",
  "author": {
    "name": "Patchbay Contributors"
  },
  "homepage": "https://github.com/engmsaleh/codex-patchbay",
  "repository": "https://github.com/engmsaleh/codex-patchbay",
  "license": "Apache-2.0",
  "keywords": [
    "codex",
    "orchestration",
    "deepseek",
    "glm",
    "claude-code",
    "code-review",
    "task-delegation",
    "verification"
  ],
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Patchbay",
    "shortDescription": "Verified multi-model delegation for Codex",
    "longDescription": "Keep Codex as orchestrator and final AI judge while DeepSeek or GLM implements bounded tasks, deterministic tools verify results, and Claude Code optionally reviews them.",
    "category": "Coding",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Use $patchbay:orchestrate to delegate this bounded implementation task",
      "Use $patchbay:review to request an independent review",
      "Use $patchbay:doctor to check worker and sandbox readiness"
    ]
  }
}
```

The exact manifest fields and MCP launch path must be validated against the targeted Codex plugin version during Milestone 0.

---

## 45. Illustrative MCP configuration

```json
{
  "mcpServers": {
    "patchbay": {
      "command": "node",
      "args": ["<resolved-plugin-root>/dist/mcp-server.mjs", "--stdio"]
    }
  }
}
```

The release implementation must use a plugin-root resolution mechanism supported by the target Codex host and must pin the server to the plugin release rather than downloading an unpinned runtime at job time.

---

## 46. Example end-to-end session

### User

```text
Use Patchbay. Have a low-cost worker fix the invitation expiry boundary bug. Keep authentication code out of scope. Run the invitation tests and typecheck. Ask Claude to review only if the patch changes production behavior. Do not apply it until I approve.
```

### Codex

Codex inspects the repository, identifies relevant files, classifies the change as medium risk, and creates a contract allowing only `src/invitations/**` and `tests/invitations/**`. It selects the cheapest healthy capable worker and calls `patchbay_delegate`.

### Patchbay

```json
{
  "job_id": "01JZPATCHBAY8A2...",
  "status": "queued",
  "worker_profile": "deepseek-capable",
  "base_commit": "a7fdcb6e4e7d...",
  "task_hash": "sha256:..."
}
```

The worker modifies two files in an isolated worktree. Patchbay extracts the diff, confirms scope, applies it to a clean verifier, and runs both commands. They pass. Because production behavior changed, Claude review runs and reports one possible exact-boundary error in the new test expectation.

Codex inspects the code and rejects the finding as a false positive because the domain specification defines expiry as strictly before the timestamp. Codex records the disposition and concludes that the verified candidate is acceptable.

### Codex to user

```text
Patchbay returned a verified two-file candidate from DeepSeek.

Evidence:
- invitation tests: passed
- typecheck: passed
- scope policy: passed
- Claude review: one finding, rejected after validation against the documented boundary semantics
- repair rounds: 0

My judgment: accept. Nothing has been applied. The candidate is based on a7fdcb6 and is ready for your approval.
```

The user approves. Codex invokes `patchbay_prepare_apply`, receives a ready plan, then invokes approval-gated `patchbay_apply`. Patchbay applies the exact patch and records the final receipt.

---

## 47. Research basis and implementation precedents

This PRD is based on the current public capabilities and documented patterns of:

- Codex plugins: manifests, skills, hooks, bundled MCP configuration, plugin data directories, and per-tool approval policies;
- Codex MCP and subagent guidance;
- OpenCode noninteractive runs, model selection, structured event output, and deny/allow permission rules;
- official DeepSeek and Z.AI coding-agent integrations;
- Claude Code noninteractive execution, structured output, permissions, and budget controls;
- the MCP task and tool-security specifications;
- existing Codex-to-Claude plugins that demonstrate session-owned background jobs, cancellation races, bounded logs, structured output, and ephemeral worktree review isolation.

Platform details evolve quickly. Milestone 0 must pin and test the exact supported Codex, OpenCode, Claude Code, DeepSeek, and GLM interfaces before freezing version 0.1 compatibility.

---

## 48. Final product statement

Codex Patchbay is not a system for letting models negotiate among themselves until something compiles. It is a system for giving Codex economical labor without surrendering authority.

Its contract with the user is simple:

```text
Codex owns the plan and final AI judgment.
DeepSeek and GLM do bounded implementation work.
Claude supplies independent criticism when it is worth the cost.
Deterministic tools produce the acceptance evidence.
Patchbay enforces the boundaries and preserves the receipts.
The user decides what enters the repository.
```
