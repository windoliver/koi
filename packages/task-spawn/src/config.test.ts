import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import { validateTaskSpawnConfig } from "./config.js";
import type { TaskableAgent, TaskSpawnResult } from "./types.js";

const MOCK_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  model: { name: "test-model" },
};

const MOCK_AGENT: TaskableAgent = {
  name: "test-agent",
  description: "A test agent",
  manifest: MOCK_MANIFEST,
};

const MOCK_SPAWN = async (): Promise<TaskSpawnResult> => ({
  ok: true,
  output: "done",
});

function validConfig(): Record<string, unknown> {
  return {
    agents: new Map([["test", MOCK_AGENT]]),
    spawn: MOCK_SPAWN,
  };
}

describe("validateTaskSpawnConfig", () => {
  it("accepts a valid config", () => {
    const result = validateTaskSpawnConfig(validConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agents.size).toBe(1);
    }
  });

  it("accepts valid config with all optional fields", () => {
    const result = validateTaskSpawnConfig({
      ...validConfig(),
      defaultAgent: "test",
      maxDurationMs: 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateTaskSpawnConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  it("rejects missing spawn function", () => {
    const result = validateTaskSpawnConfig({ agents: new Map([["test", MOCK_AGENT]]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("spawn");
    }
  });

  it("rejects non-Map agents", () => {
    const result = validateTaskSpawnConfig({
      spawn: MOCK_SPAWN,
      agents: { test: MOCK_AGENT },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Map");
    }
  });

  it("rejects empty agents map", () => {
    const result = validateTaskSpawnConfig({
      spawn: MOCK_SPAWN,
      agents: new Map(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("at least one agent");
    }
  });

  it("rejects agent map with non-string key", () => {
    const agents = new Map<unknown, unknown>();
    agents.set(42, { name: "bad", description: "desc", manifest: MOCK_MANIFEST });
    const result = validateTaskSpawnConfig({ spawn: MOCK_SPAWN, agents });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("key must be a string");
    }
  });

  it("rejects agent map with non-object value", () => {
    const agents = new Map<unknown, unknown>();
    agents.set("bad", "not-an-object");
    const result = validateTaskSpawnConfig({ spawn: MOCK_SPAWN, agents });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-null object");
    }
  });

  it("rejects agent with missing name", () => {
    const result = validateTaskSpawnConfig({
      spawn: MOCK_SPAWN,
      agents: new Map([["bad", { name: "", description: "desc", manifest: MOCK_MANIFEST }]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-empty 'name'");
    }
  });

  it("rejects agent with missing description", () => {
    const result = validateTaskSpawnConfig({
      spawn: MOCK_SPAWN,
      agents: new Map([["bad", { name: "bad", description: "", manifest: MOCK_MANIFEST }]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-empty 'description'");
    }
  });

  it("rejects agent with non-object manifest", () => {
    const result = validateTaskSpawnConfig({
      spawn: MOCK_SPAWN,
      agents: new Map([["bad", { name: "bad", description: "desc", manifest: "nope" }]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("manifest");
    }
  });

  it("rejects defaultAgent not in agents map", () => {
    const result = validateTaskSpawnConfig({
      ...validConfig(),
      defaultAgent: "nonexistent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("nonexistent");
    }
  });

  it("rejects non-string defaultAgent", () => {
    const result = validateTaskSpawnConfig({
      ...validConfig(),
      defaultAgent: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("defaultAgent");
    }
  });

  it("rejects maxDurationMs <= 0", () => {
    const result = validateTaskSpawnConfig({
      ...validConfig(),
      maxDurationMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxDurationMs");
    }
  });

  it("rejects non-integer maxDurationMs", () => {
    const result = validateTaskSpawnConfig({
      ...validConfig(),
      maxDurationMs: 1.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxDurationMs");
    }
  });

  it("rejects negative maxDurationMs", () => {
    const result = validateTaskSpawnConfig({
      ...validConfig(),
      maxDurationMs: -100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxDurationMs");
    }
  });

  it("validation errors are not retryable", () => {
    const result = validateTaskSpawnConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });
});
