// Deterministic canonical JSON + SHA-256. Task/patch/receipt hashes must be stable
// across processes and machines, so key ordering is fixed (PRD 16.3, P-06/P-07).
import { createHash } from "node:crypto";

/** Recursively sort object keys so JSON.stringify is deterministic. Arrays keep order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 hex of a string or buffer, prefixed `sha256:` for self-describing artifacts. */
export function sha256(data: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Hash of the canonical JSON form of a value. */
export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}
