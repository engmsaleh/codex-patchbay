import { test, expect } from "bun:test";
import { runDoctor, formatDoctor, type DoctorReport } from "../src/doctor.ts";

test("doctor answers in fake mode with no provider credentials", () => {
  const saved = { d: process.env.DEEPSEEK_API_KEY, z: process.env.ZAI_API_KEY };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ZAI_API_KEY;
  try {
    const r = runDoctor();
    expect(r.mode).toBe("fake");
    // Always reports the core components regardless of provider auth.
    const names = r.components.map((c) => c.name);
    expect(names).toContain("Git");
    expect(names).toContain("OpenCode");
    expect(names).toContain("Repository");
    // Worker profiles with no creds are degraded/blocked, never silently "ready".
    const deepseek = r.components.find((c) => c.name === "DeepSeek profile")!;
    expect(deepseek.status).not.toBe("ready");
  } finally {
    if (saved.d !== undefined) process.env.DEEPSEEK_API_KEY = saved.d;
    if (saved.z !== undefined) process.env.ZAI_API_KEY = saved.z;
  }
});

test("doctor flips to live mode when a provider credential is present", () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-not-a-real-key";
  try {
    const r = runDoctor();
    expect(r.mode).toBe("live");
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
});

test("doctor never leaks a credential value into its output", () => {
  const secret = "sk-super-secret-value-1234567890";
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = secret;
  try {
    const r = runDoctor();
    const rendered = formatDoctor(r) + JSON.stringify(r);
    expect(rendered).not.toContain(secret);
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
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
