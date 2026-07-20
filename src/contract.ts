// Task contract schema, validation, canonicalization, and hashing (PRD 19, 16.3).
// zod is the single source of truth; TS types are derived from it.
import { z } from "zod";
import { canonicalize, hashJson } from "./hash.ts";

// A repository-relative POSIX path/glob. Rejects absolute paths, parent escapes, and
// null bytes so a worker cannot reach outside the worktree (PRD T-05).
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\0"), "null byte in path")
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p), "absolute path not allowed")
  .refine((p) => !p.split("/").includes(".."), "parent-directory escape not allowed");

const Acceptance = z.object({
  id: z.string().min(1),
  // argv array only — no shell strings (PRD AD-09 / FR-035).
  argv: z.array(z.string().min(1)).min(1),
  cwd: RelPath.default("."),
  timeout_seconds: z.number().int().positive().max(3600).default(600),
  required: z.boolean().default(true),
});

export const ContractSchema = z
  .object({
    schema_version: z.literal("1.0"),
    objective: z.string().min(1),
    non_goals: z.array(z.string()).default([]),
    repository: z.object({
      root: z.string().min(1),
      base_commit: z.string().min(7),
      dirty_policy: z.enum(["reject", "snapshot"]).default("reject"),
    }),
    scope: z.object({
      allow: z.array(RelPath).min(1),
      deny: z.array(RelPath).default([]),
      max_changed_files: z.number().int().positive().max(1000).default(8),
      max_diff_lines: z.number().int().positive().max(100000).default(400),
      allow_binary: z.boolean().default(false),
      allow_symlink: z.boolean().default(false),
      allow_lockfile: z.boolean().default(false),
    }),
    acceptance: z.array(Acceptance).default([]),
    worker: z.object({
      profile: z.string().min(1),
      selection_reason: z.string().default(""),
    }),
    review: z
      .object({
        policy: z.enum(["never", "on-risk", "always"]).default("on-risk"),
        profile: z.string().default("claude-review"),
        modes: z.array(z.string()).default(["standard"]),
      })
      .optional(),
    budget: z
      .object({
        max_wall_seconds: z.number().int().positive().default(1800),
        max_steps: z.number().int().positive().default(15),
        max_repair_rounds: z.number().int().nonnegative().default(1),
        max_cost_usd: z.number().nonnegative().optional(),
      })
      .default({}),
    policy: z
      .object({
        allow_network: z.boolean().default(false),
        allow_commit: z.boolean().default(false),
        allow_push: z.boolean().default(false),
        recursive_delegation: z.boolean().default(false),
        require_human_apply: z.boolean().default(true),
      })
      .default({}),
    metadata: z
      .object({
        created_by: z.string().default("codex"),
        codex_session_id: z.string().default(""),
        risk: z.enum(["low", "medium", "high"]).default("medium"),
      })
      .default({}),
  })
  // Reject unknown security-sensitive fields by default (PRD 16.3).
  .strict();

export type Contract = z.infer<typeof ContractSchema>;

export interface ValidatedContract {
  contract: Contract;
  /** Canonical, immutable form used for hashing and storage. */
  canonical: Contract;
  taskHash: string;
}

/** Validate a raw contract, apply defaults, canonicalize, and hash. Throws ZodError on invalid input. */
export function validateContract(raw: unknown): ValidatedContract {
  const contract = ContractSchema.parse(raw);
  // Plugin-defined protected paths are always denied (PRD 19.2, 27.4).
  for (const p of PROTECTED_PATHS) {
    if (!contract.scope.deny.includes(p)) contract.scope.deny.push(p);
  }
  const canonical = canonicalize(contract) as Contract;
  return { contract, canonical, taskHash: hashJson(canonical) };
}

// Language-agnostic protected paths shipped by default (PRD 27.4).
export const PROTECTED_PATHS = [
  ".git/**",
  ".github/workflows/**",
  ".patchbay/**",
  "**/*.pem",
  "**/*.key",
  ".npmrc",
];
