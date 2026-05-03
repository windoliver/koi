import { describe, expect, test } from "bun:test";
import { validateTaskSpawnConfig } from "./config.js";

const validAgent = {
  name: "researcher",
  description: "Research agent",
  manifest: { name: "researcher", version: "1.0.0", model: { name: "m" } },
};

describe("validateTaskSpawnConfig", () => {
  test("requires non-null object", () => {
    const r = validateTaskSpawnConfig(null);
    expect(r.ok).toBe(false);
  });

  test("requires spawn function", () => {
    const r = validateTaskSpawnConfig({ agents: new Map([["x", validAgent]]) });
    expect(r.ok).toBe(false);
  });

  test("requires agents or agentResolver", () => {
    const r = validateTaskSpawnConfig({ spawn: () => Promise.resolve({ ok: true, output: "" }) });
    expect(r.ok).toBe(false);
  });

  test("rejects empty agents map", () => {
    const r = validateTaskSpawnConfig({
      spawn: () => Promise.resolve({ ok: true, output: "" }),
      agents: new Map(),
    });
    expect(r.ok).toBe(false);
  });

  test("accepts valid map config", () => {
    const r = validateTaskSpawnConfig({
      spawn: () => Promise.resolve({ ok: true, output: "" }),
      agents: new Map([["researcher", validAgent]]),
    });
    expect(r.ok).toBe(true);
  });

  test("accepts valid resolver config", () => {
    const r = validateTaskSpawnConfig({
      spawn: () => Promise.resolve({ ok: true, output: "" }),
      agentResolver: { resolve: () => ({ ok: true, value: validAgent }), list: () => [] },
    });
    expect(r.ok).toBe(true);
  });

  test("rejects defaultAgent missing from map", () => {
    const r = validateTaskSpawnConfig({
      spawn: () => Promise.resolve({ ok: true, output: "" }),
      agents: new Map([["researcher", validAgent]]),
      defaultAgent: "missing",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects non-positive maxDurationMs", () => {
    const r = validateTaskSpawnConfig({
      spawn: () => Promise.resolve({ ok: true, output: "" }),
      agents: new Map([["researcher", validAgent]]),
      maxDurationMs: 0,
    });
    expect(r.ok).toBe(false);
  });

  test("rejects non-function message", () => {
    const r = validateTaskSpawnConfig({
      spawn: () => Promise.resolve({ ok: true, output: "" }),
      agents: new Map([["researcher", validAgent]]),
      message: 42,
    });
    expect(r.ok).toBe(false);
  });
});
