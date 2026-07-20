// Patch policy gate: enforces scope, protected paths, and artifact limits on the
// files a worker changed — AFTER execution, using a full Git inventory (PRD 16.10, T-02).
import type { Contract } from "./contract.ts";

export type ChangeType = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string; // repository-relative POSIX
  type: ChangeType;
  isSymlink: boolean;
  isBinary: boolean;
  /** Added + removed line count for text files (0 for binary). */
  churn: number;
}

export interface PolicyViolation {
  code:
    | "out_of_scope"
    | "protected_path"
    | "too_many_files"
    | "diff_too_large"
    | "binary_not_allowed"
    | "symlink_not_allowed"
    | "lockfile_not_allowed"
    | "possible_secret";
  path?: string;
  detail: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
}

// Common dependency lockfiles. Changing these is denied unless the contract opts in,
// since a worker can smuggle dependency changes past a narrow scope.
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
]);

/** Minimal glob → RegExp. Supports `**` (any depth), `*` (within a segment), `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` matches zero or more leading segments
        } else {
          re += ".*"; // trailing/standalone `**`
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Basename check so a lockfile at any depth is caught. */
function isLockfile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return LOCKFILES.has(base);
}

/**
 * Check every changed file against the contract scope and limits.
 * `patchText` is the canonical unified diff, scanned for obvious secrets.
 */
export function checkPolicy(contract: Contract, changes: ChangedFile[], patchText: string): PolicyResult {
  const { scope } = contract;
  const violations: PolicyViolation[] = [];

  for (const f of changes) {
    // Protected/denied paths first — these override any allow match.
    if (matchesAny(f.path, scope.deny)) {
      violations.push({ code: "protected_path", path: f.path, detail: `matches a denied/protected pattern` });
      continue;
    }
    if (!matchesAny(f.path, scope.allow)) {
      violations.push({ code: "out_of_scope", path: f.path, detail: `not within any allowed path` });
      continue;
    }
    if (f.isSymlink && !scope.allow_symlink) {
      violations.push({ code: "symlink_not_allowed", path: f.path, detail: "symlink change not permitted" });
    }
    if (f.isBinary && !scope.allow_binary) {
      violations.push({ code: "binary_not_allowed", path: f.path, detail: "binary change not permitted" });
    }
    if (isLockfile(f.path) && !scope.allow_lockfile) {
      violations.push({ code: "lockfile_not_allowed", path: f.path, detail: "lockfile change not permitted" });
    }
  }

  if (changes.length > scope.max_changed_files) {
    violations.push({
      code: "too_many_files",
      detail: `${changes.length} files changed, limit ${scope.max_changed_files}`,
    });
  }

  const totalChurn = changes.reduce((n, f) => n + f.churn, 0);
  if (totalChurn > scope.max_diff_lines) {
    violations.push({
      code: "diff_too_large",
      detail: `${totalChurn} diff lines, limit ${scope.max_diff_lines}`,
    });
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(patchText)) {
    violations.push({ code: "possible_secret", detail: "patch appears to contain a private key" });
  }

  return { ok: violations.length === 0, violations };
}
