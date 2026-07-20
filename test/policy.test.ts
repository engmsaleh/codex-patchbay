import { test, expect } from "bun:test";
import { globToRegExp, matchesAny, checkPolicy } from "../src/policy.ts";
import { validateContract } from "../src/contract.ts";

test("glob ** matches any depth; * stays within a segment", () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  expect(m("src/**", "src/a.ts")).toBe(true);
  expect(m("src/**", "src/a/b/c.ts")).toBe(true);
  expect(m("src/**", "lib/a.ts")).toBe(false);
  expect(m("src/**", "src")).toBe(false); // no file under src
  expect(m("**/*.pem", "a.pem")).toBe(true);
  expect(m("**/*.pem", "deep/nested/key.pem")).toBe(true);
  expect(m("**/*.pem", "a.pemx")).toBe(false);
  expect(m("*.key", "id.key")).toBe(true);
  expect(m("*.key", "dir/id.key")).toBe(false); // * does not cross /
  expect(m(".github/workflows/**", ".github/workflows/ci.yml")).toBe(true);
});

test("protected deny overrides a broad allow", () => {
  const vc = validateContract({
    schema_version: "1.0",
    objective: "x",
    repository: { root: "/r", base_commit: "abcdef0", dirty_policy: "reject" },
    scope: { allow: ["**"] },
    worker: { profile: "fake" },
  });
  const res = checkPolicy(
    vc.canonical,
    [{ path: ".github/workflows/ci.yml", type: "modified", isSymlink: false, isBinary: false, churn: 3 }],
    "",
  );
  expect(res.ok).toBe(false);
  expect(res.violations[0]!.code).toBe("protected_path");
});

test("lockfile, binary, symlink, and diff-size limits are enforced", () => {
  const vc = validateContract({
    schema_version: "1.0",
    objective: "x",
    repository: { root: "/r", base_commit: "abcdef0", dirty_policy: "reject" },
    scope: { allow: ["**"], max_diff_lines: 10 },
    worker: { profile: "fake" },
  });
  const res = checkPolicy(
    vc.canonical,
    [
      { path: "pnpm-lock.yaml", type: "modified", isSymlink: false, isBinary: false, churn: 5 },
      { path: "img.png", type: "added", isSymlink: false, isBinary: true, churn: 0 },
      { path: "link", type: "added", isSymlink: true, isBinary: false, churn: 20 },
    ],
    "",
  );
  const codes = new Set(res.violations.map((v) => v.code));
  expect(codes.has("lockfile_not_allowed")).toBe(true);
  expect(codes.has("binary_not_allowed")).toBe(true);
  expect(codes.has("symlink_not_allowed")).toBe(true);
  expect(codes.has("diff_too_large")).toBe(true);
});

test("private key in patch text is flagged", () => {
  const vc = validateContract({
    schema_version: "1.0",
    objective: "x",
    repository: { root: "/r", base_commit: "abcdef0", dirty_policy: "reject" },
    scope: { allow: ["**"] },
    worker: { profile: "fake" },
  });
  const res = checkPolicy(vc.canonical, [], "+-----BEGIN RSA PRIVATE KEY-----\n");
  expect(res.violations.some((v) => v.code === "possible_secret")).toBe(true);
});

test("matchesAny handles empty glob lists", () => {
  expect(matchesAny("a.ts", [])).toBe(false);
});
