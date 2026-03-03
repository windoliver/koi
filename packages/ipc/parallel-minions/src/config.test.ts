import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import { validateParallelMinionsConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_MANIFEST: AgentManifest = {
  name: "test-worker",
  version: "0.0.1",
  model: { name: "mock" },
};

function validConfig(): Record<string, unknown> {
  return {
    agents: new Map([
      [
        "worker",
        {
          name: "test-worker",
          description: "A test worker",
          manifest: TEST_MANIFEST,
        },
      ],
    ]),
    spawn: async () => ({ ok: true, output: "ok" }),
    defaultAgent: "worker",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateParallelMinionsConfig", () => {
  it("accepts valid config", () => {
    const result = validateParallelMinionsConfig(validConfig());
    expect(result.ok).toBe(true);
  });

  it("accepts valid config with all optional fields", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxConcurrency: 3,
      maxDurationMs: 60_000,
      maxOutputPerTask: 1_000,
      maxTotalOutput: 10_000,
      strategy: "quorum",
      quorumThreshold: 2,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects null config", () => {
    const result = validateParallelMinionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null object");
  });

  it("rejects non-object config", () => {
    const result = validateParallelMinionsConfig("string");
    expect(result.ok).toBe(false);
  });

  it("rejects missing spawn", () => {
    const config = validConfig();
    delete config.spawn;
    const result = validateParallelMinionsConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("spawn");
  });

  it("rejects non-function spawn", () => {
    const result = validateParallelMinionsConfig({ ...validConfig(), spawn: "not-a-fn" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing agents", () => {
    const config = validConfig();
    delete config.agents;
    const result = validateParallelMinionsConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("agents");
  });

  it("rejects non-Map agents", () => {
    const result = validateParallelMinionsConfig({ ...validConfig(), agents: {} });
    expect(result.ok).toBe(false);
  });

  it("rejects empty agents map", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      agents: new Map(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("at least one agent");
  });

  it("rejects agent with empty name", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      agents: new Map([["worker", { name: "", description: "desc", manifest: TEST_MANIFEST }]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-empty 'name'");
  });

  it("rejects agent with empty description", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      agents: new Map([["worker", { name: "w", description: "", manifest: TEST_MANIFEST }]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-empty 'description'");
  });

  it("rejects agent with missing manifest", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      agents: new Map([["worker", { name: "w", description: "d" }]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("manifest");
  });

  it("rejects defaultAgent not in agents map", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      defaultAgent: "nonexistent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("nonexistent");
  });

  it("rejects non-string defaultAgent", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      defaultAgent: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("string");
  });

  it("rejects non-integer maxConcurrency", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxConcurrency: 2.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxConcurrency");
  });

  it("rejects zero maxConcurrency", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxConcurrency: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative maxDurationMs", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxDurationMs: -1,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-integer maxOutputPerTask", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxOutputPerTask: 1.5,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-integer maxTotalOutput", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxTotalOutput: Infinity,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid strategy", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      strategy: "invalid-strategy",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("best-effort");
  });

  it("rejects quorum strategy without quorumThreshold", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      strategy: "quorum",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("quorumThreshold");
  });

  it("rejects quorum strategy with non-integer quorumThreshold", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      strategy: "quorum",
      quorumThreshold: 1.5,
    });
    expect(result.ok).toBe(false);
  });

  it("ignores quorumThreshold when strategy is not quorum", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      strategy: "best-effort",
      quorumThreshold: 5,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts valid laneConcurrency", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      laneConcurrency: new Map([["worker", 3]]),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-Map laneConcurrency", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      laneConcurrency: { worker: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("laneConcurrency");
  });

  it("rejects laneConcurrency key not in agents", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      laneConcurrency: new Map([["nonexistent", 2]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("nonexistent");
  });

  it("rejects laneConcurrency with non-integer value", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      laneConcurrency: new Map([["worker", 1.5]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("finite positive integer");
  });

  it("rejects laneConcurrency with zero value", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      laneConcurrency: new Map([["worker", 0]]),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects laneConcurrency value exceeding maxConcurrency", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      maxConcurrency: 3,
      laneConcurrency: new Map([["worker", 5]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("exceeds maxConcurrency");
  });

  it("rejects laneConcurrency value exceeding default maxConcurrency", () => {
    const result = validateParallelMinionsConfig({
      ...validConfig(),
      laneConcurrency: new Map([["worker", 10]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("exceeds maxConcurrency");
  });

  it("accepts config without optional fields", () => {
    const config = {
      agents: new Map([
        [
          "worker",
          {
            name: "test-worker",
            description: "A test worker",
            manifest: TEST_MANIFEST,
          },
        ],
      ]),
      spawn: async () => ({ ok: true, output: "ok" }),
    };
    const result = validateParallelMinionsConfig(config);
    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION error code on failure", () => {
    const result = validateParallelMinionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });
});
