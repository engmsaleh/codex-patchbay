import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, formatDoctor, type DoctorReport } from "../src/doctor.ts";

// Point auth resolution at a controlled file so tests are hermetic regardless of the
// developer's real OpenCode login.
function withAuth<T>(present: boolean, secret: string, fn: () => T): T {
  const saved = process.env.PATCHBAY_OPENCODE_AUTH;
  const savedClaude = process.env.PATCHBAY_CLAUDE_WORKER_BIN;
  const dir = mkdtempSync(join(tmpdir(), "pb-auth-"));
  const path = join(dir, "auth.json");
  if (present) writeFileSync(path, JSON.stringify({ "opencode-go": { type: "api", key: secret } }));
  process.env.PATCHBAY_OPENCODE_AUTH = present ? path : join(dir, "missing.json");
  // Pin the Claude worker binary to a bogus path so doctor mode is driven purely by the
  // OpenCode auth file, hermetically, regardless of whether this machine has `claude`.
  process.env.PATCHBAY_CLAUDE_WORKER_BIN = join(dir, "no-claude");
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATCHBAY_OPENCODE_AUTH;
    else process.env.PATCHBAY_OPENCODE_AUTH = saved;
    if (savedClaude === undefined) delete process.env.PATCHBAY_CLAUDE_WORKER_BIN;
    else process.env.PATCHBAY_CLAUDE_WORKER_BIN = savedClaude;
  }
}

test("doctor answers in fake mode when the subscription is not authenticated", () => {
  withAuth(false, "", () => {
    const r = runDoctor();
    expect(r.mode).toBe("fake");
    const names = r.components.map((c) => c.name);
    expect(names).toContain("Git");
    expect(names).toContain("OpenCode");
    expect(names).toContain("Repository");
    const deepseek = r.components.find((c) => c.name === "DeepSeek profile")!;
    expect(deepseek.status).not.toBe("ready"); // never silently ready without auth
  });
});

test("doctor flips to live mode when the OpenCode Go subscription is authenticated", () => {
  withAuth(true, "sk-secret", () => {
    const r = runDoctor();
    expect(r.mode).toBe("live");
  });
});

test("doctor never leaks the subscription credential value", () => {
  const secret = "sk-super-secret-value-1234567890";
  withAuth(true, secret, () => {
    const r = runDoctor();
    const rendered = formatDoctor(r) + JSON.stringify(r);
    expect(rendered).not.toContain(secret);
  });
});

test("format output is stable and lists workflows", () => {
  const report: DoctorReport = {
    version: "0.1.0",
    mode: "fake",
    components: [{ name: "Git", status: "ready", detail: "2.50.0" }],
    availableWorkflows: ["Claude review"],
    unavailable: ["DeepSeek implementation"],
  };
  const out = formatDoctor(report);
  expect(out).toContain("Patchbay doctor");
  expect(out).toContain("Available workflows: Claude review");
  expect(out).toContain("Unavailable: DeepSeek implementation");
});
