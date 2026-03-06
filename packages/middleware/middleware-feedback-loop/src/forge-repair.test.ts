import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, ForgeStore, KoiError, Result, ToolArtifact } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import type { ForgeRepairConfig } from "./forge-repair.js";
import { createForgeRepairStrategy } from "./forge-repair.js";
import type { ToolHealthTracker } from "./tool-health.js";
import type { ValidationError } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user",
      timestamp: 1000,
      content: [{ kind: "text", text: "hello" }],
    },
  ],
};

const baseResponse: ModelResponse = {
  content: "some output",
  model: "test-model",
};

const sampleErrors: readonly ValidationError[] = [
  { validator: "schema-check", message: "Missing field 'name'", path: "forged-tool-1" },
];

const defaultToolArtifact: ToolArtifact = {
  kind: "tool",
  id: brickId("brick-1"),
  name: "my-tool",
  implementation: "function run(input) { return input; }",
  inputSchema: {},
  testCases: [{ name: "basic", input: { x: 1 }, expectedOutput: { x: 1 } }],
  description: "A test tool",
  scope: "agent",
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "1.0.0",
  tags: [],
  usageCount: 0,
};

function createMockForgeStore(loadResult?: Result<BrickArtifact, KoiError>): ForgeStore {
  const defaultResult: Result<BrickArtifact, KoiError> = {
    ok: true,
    value: defaultToolArtifact,
  };
  return {
    save: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    load: mock(() => Promise.resolve(loadResult ?? defaultResult)),
    search: mock(() =>
      Promise.resolve({ ok: true as const, value: [] as readonly BrickArtifact[] }),
    ),
    remove: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    update: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    exists: mock(() => Promise.resolve({ ok: true as const, value: false })),
  };
}

function createMockHealthTracker(snapshot?: Record<string, unknown>): ToolHealthTracker {
  const defaultSnapshot = {
    brickId: "brick-1",
    toolId: "forged-tool-1",
    metrics: { successRate: 0.5, errorRate: 0.5, usageCount: 10, avgLatencyMs: 50 },
    state: "degraded" as const,
    recentFailures: [
      { timestamp: 900, error: "timeout", latencyMs: 5000 },
      { timestamp: 950, error: "parse error", latencyMs: 100 },
    ],
    lastUpdatedAt: 1000,
  };
  return {
    recordSuccess: mock(() => {}),
    recordFailure: mock(() => {}),
    getSnapshot: mock(() => (snapshot ?? defaultSnapshot) as never),
    isQuarantined: mock(() => false),
    isQuarantinedAsync: mock(() => Promise.resolve(false)),
    checkAndQuarantine: mock(() => Promise.resolve(false)),
    checkAndDemote: mock(() => Promise.resolve(false)),
    getAllSnapshots: mock(() => []),
    shouldFlushTool: mock(() => false),
    flushTool: mock(() => Promise.resolve()),
    flush: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
  };
}

function createConfig(overrides?: Partial<ForgeRepairConfig>): ForgeRepairConfig {
  return {
    forgeStore: createMockForgeStore(),
    healthTracker: createMockHealthTracker(),
    resolveBrickId: (toolId: string) =>
      toolId.startsWith("forged-") ? `brick-${toolId}` : undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeRepairStrategy", () => {
  test("enriches retry request with source code and test cases", async () => {
    const strategy = createForgeRepairStrategy(createConfig());
    const result = await strategy.buildRetryRequest(baseRequest, baseResponse, sampleErrors, 1);

    expect(result.messages.length).toBe(3); // original + assistant + error
    const errorMsg = result.messages[2];
    expect(errorMsg?.senderId).toBe("system:feedback-loop");
    const text = errorMsg?.content[0];
    expect(text?.kind).toBe("text");
    if (text?.kind === "text") {
      expect(text.text).toContain("Tool Source");
      expect(text.text).toContain("function run(input)");
      expect(text.text).toContain("Test Cases");
      expect(text.text).toContain("basic");
    }
  });

  test("includes health metrics and recent failures", async () => {
    const strategy = createForgeRepairStrategy(createConfig());
    const result = await strategy.buildRetryRequest(baseRequest, baseResponse, sampleErrors, 1);

    const text = result.messages[2]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("Health Metrics");
      expect(text.text).toContain("Error rate: 50%");
      expect(text.text).toContain("Recent Failures");
      expect(text.text).toContain("timeout");
      expect(text.text).toContain("Suggestion");
    }
  });

  test("falls back to basic error text when brickId is not resolvable", async () => {
    const strategy = createForgeRepairStrategy(createConfig({ resolveBrickId: () => undefined }));
    const result = await strategy.buildRetryRequest(baseRequest, baseResponse, sampleErrors, 1);

    const text = result.messages[2]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).not.toContain("Tool Source");
      expect(text.text).toContain("validation errors");
      expect(text.text).toContain("Missing field 'name'");
    }
  });

  test("falls back when forge store load fails", async () => {
    const failingStore = createMockForgeStore({
      ok: false,
      error: { code: "NOT_FOUND", message: "not found", retryable: false },
    });
    const strategy = createForgeRepairStrategy(createConfig({ forgeStore: failingStore }));
    const result = await strategy.buildRetryRequest(baseRequest, baseResponse, sampleErrors, 1);

    const text = result.messages[2]?.content[0];
    if (text?.kind === "text") {
      // Should still include health metrics from tracker even if store fails
      expect(text.text).toContain("Health Metrics");
      expect(text.text).not.toContain("Tool Source");
    }
  });

  test("includes suggestion about test cases when present", async () => {
    const strategy = createForgeRepairStrategy(createConfig());
    const result = await strategy.buildRetryRequest(baseRequest, baseResponse, sampleErrors, 1);

    const text = result.messages[2]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("Review the test cases below");
    }
  });

  test("preserves original request messages", async () => {
    const strategy = createForgeRepairStrategy(createConfig());
    const result = await strategy.buildRetryRequest(baseRequest, baseResponse, sampleErrors, 2);

    expect(result.messages[0]?.senderId).toBe("user");
    expect(result.messages[1]?.senderId).toBe("assistant");
    expect(result.messages[2]?.senderId).toBe("system:feedback-loop");
  });
});
