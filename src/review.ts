// Reviewer adapter surface (PRD 17.4, 25). Executes a constrained, read-only review
// request and validates structured findings output.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { Contract } from "./contract.ts";
import { canonicalize, hashJson } from "./hash.ts";

const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  category: z.string().min(1).default("correctness"),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  symbol: z.string().optional(),
  claim: z.string().min(1),
  evidence: z.string().min(1),
  reproduction: z.string().optional(),
  suggested_check: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();

const ReviewPayloadSchema = z
  .object({
    verdict: z.enum(["changes_requested", "approved", "no_findings", "approved_with_notes"]).default("no_findings"),
    findings: z.array(FindingSchema).default([]),
    uncertainties: z.array(z.string()).default([]),
  })
  .strict();

export type ReviewMode = "standard" | "adversarial" | "security" | "design";

export type ReviewDisposition =
  | "confirmed"
  | "rejected_false_positive"
  | "duplicate"
  | "needs_experiment"
  | "needs_human_decision"
  | "out_of_scope";

export interface FindingDispositionInput {
  id: string;
  disposition: ReviewDisposition;
}

export interface DispositionRecord {
  findingId: string;
  file?: string;
  line?: number;
  category?: string;
  disposition: ReviewDisposition;
  reportedAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  file?: string;
  line?: number;
  symbol?: string;
  claim: string;
  evidence: string;
  reproduction?: string;
  suggested_check?: string;
  confidence: number;
}

export interface ReviewResult {
  ok: boolean;
  verdict: "changes_requested" | "approved" | "no_findings" | "approved_with_notes";
  findings: ReviewFinding[];
  uncertainties: string[];
  parseStatus: "ok" | "invalid_json" | "schema_mismatch" | "command_failed";
  parseError?: string;
  raw: string;
  rawCommand: string;
  usedProfile: string;
  reviewHash: string;
}

export interface RunReviewArgs {
  contract: Contract;
  patch: string;
  profile?: string;
  modes?: ReviewMode[];
  timeoutSec?: number;
  maxOutputBytes?: number;
}

function reviewBin(): string {
  return process.env.PATCHBAY_CLAUDE_BIN ?? "claude";
}

function buildPrompt(contract: Contract, patch: string, modes: ReviewMode[]): string {
  const mode = modes.length ? modes.join(", ") : "standard";
  return [
    "You are a strict code reviewer for a Patchbay candidate patch.",
    "Return JSON only. Never include markdown, extra prose, or shell commands.",
    "Output STRICT JSON matching this schema:",
    '{"verdict":"changes_requested|approved|no_findings|approved_with_notes","findings":[{',
    '"id":"R-001","severity":"low|medium|high|critical","category":"correctness",',
    '"file":"src/file.ts","line":12,"symbol":"fn","claim":"...","evidence":"...","reproduction":"...","suggested_check":"...","confidence":0.85',
    '}],"uncertainties":[]}',
    "",
    `Objective: ${contract.objective}`,
    `Risk: ${contract.metadata.risk}`,
    `Allowed paths: ${contract.scope.allow.join(", ")}`,
    `Review modes: ${mode}`,
    `Candidate patch (unified diff):`,
    patch,
  ].join("\n");
}

function parseReviewOutput(raw: string): { payload?: z.infer<typeof ReviewPayloadSchema>; error?: string; status: ReviewResult["parseStatus"] } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  let lastJsonError: string | undefined;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      const parsedWithDefaults = ReviewPayloadSchema.parse(parsed);
      return { payload: parsedWithDefaults, status: "ok" };
    } catch (e) {
      if (e instanceof Error) {
        lastJsonError = lastJsonError ?? e.message;
        continue;
      }
      return { status: "invalid_json", error: "invalid json line" };
    }
  }
  try {
    const parsed = JSON.parse(raw);
    const parsedWithDefaults = ReviewPayloadSchema.parse(parsed);
    return { payload: parsedWithDefaults, status: "ok" };
  } catch (e) {
    if (e instanceof Error) return { status: "invalid_json", error: lastJsonError ?? e.message };
    return { status: "invalid_json", error: lastJsonError ?? "invalid json" };
  }
}

/** Execute the reviewer and return structured findings with a deterministic review hash. */
export async function runReview(args: RunReviewArgs): Promise<ReviewResult> {
  const modes = (args.modes?.length ? args.modes : ["standard"]) as ReviewMode[];
  const timeoutMs = (args.timeoutSec ?? 60) * 1000;
  const maxBuffer = (args.maxOutputBytes ?? 1_048_576) * 2;
  const profile = args.profile ?? "claude-review";
  const prompt = buildPrompt(args.contract, args.patch.slice(0, 24_000), modes);
  const bin = reviewBin();

  try {
    const outcome = spawnSync(
      bin,
      ["-p", prompt],
      {
        shell: false,
        env: process.env as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
      },
    );

    const raw = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`;
    if (outcome.error) {
      return {
        ok: false,
        verdict: "changes_requested",
        findings: [],
        uncertainties: [`review command failed: ${outcome.error.message}`],
        parseStatus: "command_failed",
        parseError: outcome.error.message,
        raw,
        rawCommand: `${bin} -p <prompt>`,
        usedProfile: profile,
        reviewHash: hashJson(canonicalize({ command: "error", message: outcome.error.message })),
      };
    }
    if (outcome.status !== 0 && outcome.status !== null) {
      return {
        ok: false,
        verdict: "changes_requested",
        findings: [],
        uncertainties: [`review command exited ${outcome.status}`],
        parseStatus: "command_failed",
        parseError: `command exited ${outcome.status}`,
        raw,
        rawCommand: `${bin} -p <prompt>`,
        usedProfile: profile,
        reviewHash: hashJson(canonicalize({ command: "exit", status: outcome.status })),
      };
    }
    const parse = parseReviewOutput(raw);
    if (!parse.payload) {
      return {
        ok: false,
        verdict: "changes_requested",
        findings: [],
        uncertainties: [parse.error ?? "no parseable review JSON found"],
        parseStatus: parse.status,
        parseError: parse.error,
        raw,
        rawCommand: `${bin} -p <prompt>`,
        usedProfile: profile,
        reviewHash: hashJson(canonicalize({ command: "parse_failed", status: parse.status, raw })),
      };
    }
    const reviewPayload = parse.payload;
    const findings = reviewPayload.findings as ReviewFinding[];
    const reviewHash = hashJson(canonicalize({ verdict: reviewPayload.verdict, findings, uncertainties: reviewPayload.uncertainties }));
    return {
      ok: true,
      verdict: reviewPayload.verdict,
      findings,
      uncertainties: reviewPayload.uncertainties,
      parseStatus: "ok",
      raw,
      rawCommand: `${bin} -p <prompt>`,
      usedProfile: profile,
      reviewHash,
    };
  } catch (e) {
    return {
      ok: false,
      verdict: "changes_requested",
      findings: [],
      uncertainties: [e instanceof Error ? e.message : String(e)],
      parseStatus: "command_failed",
      parseError: e instanceof Error ? e.message : String(e),
      raw: "",
      rawCommand: `${bin} -p <prompt>`,
      usedProfile: profile,
      reviewHash: hashJson(canonicalize({ command: "exception", error: e instanceof Error ? e.message : String(e) })),
    };
  }
}

export interface StoredReviewArtifact {
  reviewedAt: string;
  profile: string;
  modes: ReviewMode[];
  verdict: ReviewResult["verdict"];
  findings: ReviewFinding[];
  uncertainties: string[];
  parseStatus: ReviewResult["parseStatus"];
  parseError?: string;
  raw: string;
  reviewHash: string;
}
