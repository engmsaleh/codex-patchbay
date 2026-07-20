// Worker profiles (PRD 16.5, 18). Model IDs are config, not product logic (P-08): each
// profile carries a recommended alias overridable by an env var, resolved at runtime.
//
// Auth: the primary path is the OpenCode Go subscription (credential in OpenCode's own
// auth store), so no per-provider API keys are required. A direct provider-env mode is
// also supported. ponytail: built-in profiles are the source of truth; user/repo TOML
// profile loading + precedence merging is a later increment.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthSpec =
  | { mode: "opencode_subscription"; provider: string } // credential lives in OpenCode's auth.json
  | { mode: "provider_env"; envAllow: string[] }; // credential passed as an API-key env var

export interface WorkerProfile {
  id: string;
  runtime: "opencode";
  /** Env var that overrides the model; falls back to `defaultModel`. Full "provider/model". */
  modelEnv: string;
  defaultModel: string;
  mode: "write";
  limits: { maxWallSeconds: number; maxOutputBytes: number };
  auth: AuthSpec;
}

export const PROFILES: Record<string, WorkerProfile> = {
  "deepseek-fast": {
    id: "deepseek-fast",
    runtime: "opencode",
    modelEnv: "PATCHBAY_DEEPSEEK_FAST_MODEL",
    defaultModel: "opencode-go/deepseek-v4-flash",
    mode: "write",
    limits: { maxWallSeconds: 1200, maxOutputBytes: 1_048_576 },
    auth: { mode: "opencode_subscription", provider: "opencode-go" },
  },
  "deepseek-capable": {
    id: "deepseek-capable",
    runtime: "opencode",
    modelEnv: "PATCHBAY_DEEPSEEK_CAPABLE_MODEL",
    defaultModel: "opencode-go/deepseek-v4-pro",
    mode: "write",
    limits: { maxWallSeconds: 1800, maxOutputBytes: 1_048_576 },
    auth: { mode: "opencode_subscription", provider: "opencode-go" },
  },
  "glm-fast": {
    id: "glm-fast",
    runtime: "opencode",
    modelEnv: "PATCHBAY_GLM_FAST_MODEL",
    defaultModel: "opencode-go/glm-5.1",
    mode: "write",
    limits: { maxWallSeconds: 1200, maxOutputBytes: 1_048_576 },
    auth: { mode: "opencode_subscription", provider: "opencode-go" },
  },
  "glm-capable": {
    id: "glm-capable",
    runtime: "opencode",
    modelEnv: "PATCHBAY_GLM_CAPABLE_MODEL",
    defaultModel: "opencode-go/glm-5.2",
    mode: "write",
    limits: { maxWallSeconds: 1800, maxOutputBytes: 1_048_576 },
    auth: { mode: "opencode_subscription", provider: "opencode-go" },
  },
};

export function getProfile(id: string): WorkerProfile | undefined {
  return PROFILES[id];
}

/** Resolve the full "provider/model" for a profile: env override wins, else the alias. */
export function resolveModel(p: WorkerProfile): string {
  return process.env[p.modelEnv] ?? p.defaultModel;
}

/** Path to OpenCode's credential store. Injectable via PATCHBAY_OPENCODE_AUTH for tests. */
export function opencodeAuthPath(): string {
  if (process.env.PATCHBAY_OPENCODE_AUTH) return process.env.PATCHBAY_OPENCODE_AUTH;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

/** True if the profile's credential is present. Reads only key existence — never a value. */
export function authAvailable(p: WorkerProfile): boolean {
  if (p.auth.mode === "provider_env") return p.auth.envAllow.every((e) => !!process.env[e]);
  try {
    const all = JSON.parse(readFileSync(opencodeAuthPath(), "utf8")) as Record<string, unknown>;
    return !!all[p.auth.provider];
  } catch {
    return false;
  }
}
