/**
 * Integration test for @koi/auto-harness.
 *
 * Tests the full pipeline: demand signal → synthesis → search → save → policy cache.
 * LLM is mocked with deterministic responses.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  BrickId,
  ForgeDemandSignal,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { createAutoHarnessStack } from "./create-auto-harness-stack.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const VALID_MIDDLEWARE_CODE = `export function createMiddleware() {
  return {
    name: "harness-search",
    priority: 180,
    phase: "intercept",
    async wrapToolCall(ctx, req, next) {
      if (req.toolId !== "search") return next(req);
      if (!req.input?.query || typeof req.input.query !== "string") {
        return { output: { error: true, message: "Query must be a non-empty string" } };
      }
      return next(req);
    },
    describeCapabilities() { return undefined; },
  };
}`;

const LLM_RESPONSE = `Here is the middleware:

\`\`\`typescript
${VALID_MIDDLEWARE_CODE}
\`\`\``;

function createMockForgeStore(): ForgeStore {
  const saved: BrickArtifact[] = []; // let: mutable test accumulator

  return {
    save: mock(async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
      saved.push(brick);
      return { ok: true, value: undefined };
    }),
    load: mock(
      async (_id: BrickId): Promise<Result<BrickArtifact, KoiError>> => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "Not found", retryable: false },
      }),
    ),
    search: mock(
      async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
        ok: true,
        value: [],
      }),
    ),
    remove: mock(
      async (): Promise<Result<void, KoiError>> => ({
        ok: true,
        value: undefined,
      }),
    ),
    update: mock(
      async (): Promise<Result<void, KoiError>> => ({
        ok: true,
        value: undefined,
      }),
    ),
    exists: mock(
      async (): Promise<Result<boolean, KoiError>> => ({
        ok: true,
        value: false,
      }),
    ),
  };
}

function createDemandSignal(overrides: Partial<ForgeDemandSignal> = {}): ForgeDemandSignal {
  return {
    id: "demand-1",
    kind: "forge_demand",
    trigger: { kind: "repeated_failure", toolName: "search", count: 5 },
    confidence: 0.9,
    suggestedBrickKind: "tool",
    context: {
      failureCount: 5,
      failedToolCalls: [
        "search: Missing query parameter",
        "search: Exceeded 30s limit",
        "search: Too many requests",
      ],
    },
    emittedAt: 1_700_000_000_000,
    ...overrides,
  } as ForgeDemandSignal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAutoHarnessStack", () => {
  test("returns stack with policy-cache middleware and synthesize callback", () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(stack.policyCacheMiddleware.priority).toBe(150);
    expect(typeof stack.synthesizeHarness).toBe("function");
    expect(stack.maxSynthesesPerSession).toBe(3);
  });

  test("synthesizeHarness produces a brick from failure-driven demand signal", async () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      clock: () => 1_700_000_000_000,
    });

    const signal = createDemandSignal();
    const brick = await stack.synthesizeHarness(signal);

    expect(brick).not.toBeNull();
    expect(brick?.kind).toBe("middleware");
    expect(brick?.name).toContain("harness");
    const source = brick?.provenance.source;
    expect(source?.origin).toBe("forged");
    if (source !== undefined && source.origin === "forged") {
      expect(source.forgedBy).toBe("harness-synth");
    }
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  test("synthesized brick is saved as draft with verification.passed: false", async () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      clock: () => 1_700_000_000_000,
    });

    const signal = createDemandSignal();
    const brick = await stack.synthesizeHarness(signal);

    expect(brick).not.toBeNull();
    // Brick must NOT be saved as active — it hasn't been forge-verified yet
    expect(brick?.lifecycle).toBe("draft");
    expect(brick?.provenance.verification.passed).toBe(false);
    expect(brick?.provenance.verification.sandbox).toBe(false);
  });

  test("synthesizeHarness returns null when no failures in signal", async () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
    });

    const signal = createDemandSignal({
      context: { failureCount: 0, failedToolCalls: [] },
      emittedAt: 1_700_000_000_000,
    });
    const brick = await stack.synthesizeHarness(signal);

    expect(brick).toBeNull();
    expect(store.save).not.toHaveBeenCalled();
  });

  test("synthesizeHarness returns null when LLM fails", async () => {
    const store = createMockForgeStore();
    const errors: unknown[] = []; // let: test accumulator
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => {
        throw new Error("LLM unavailable");
      },
      onError: (err) => errors.push(err),
    });

    const signal = createDemandSignal();
    const brick = await stack.synthesizeHarness(signal);

    expect(brick).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("synthesizeHarness returns null when store save fails", async () => {
    const store = createMockForgeStore();
    (store.save as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "Store down", retryable: false },
    }));

    const errors: unknown[] = []; // let: test accumulator
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      onError: (err) => errors.push(err),
    });

    const signal = createDemandSignal();
    const brick = await stack.synthesizeHarness(signal);

    expect(brick).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("calls notifier after successful save", async () => {
    const store = createMockForgeStore();
    const notifyMock = mock(async () => {});
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      notifier: {
        notify: notifyMock,
        subscribe: () => {},
      } as never,
    });

    const signal = createDemandSignal();
    await stack.synthesizeHarness(signal);

    // Give fire-and-forget time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifyMock).toHaveBeenCalled();
  });

  test("policy-cache handle is functional", () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
    });

    expect(stack.policyCacheHandle.size()).toBe(0);
    stack.policyCacheHandle.register({
      toolId: "search",
      brickId: "brick-1",
      execute: () => ({ action: "allow" as const }),
    });
    expect(stack.policyCacheHandle.size()).toBe(1);
    stack.policyCacheHandle.evict("brick-1");
    expect(stack.policyCacheHandle.size()).toBe(0);
  });

  test("blocks repeat synthesis for same tool (recursion prevention)", async () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      clock: () => 1_700_000_000_000,
    });

    const signal = createDemandSignal();

    // First synthesis succeeds
    const brick1 = await stack.synthesizeHarness(signal);
    expect(brick1).not.toBeNull();
    expect(store.save).toHaveBeenCalledTimes(1);

    // Second synthesis for same tool is blocked
    const brick2 = await stack.synthesizeHarness(signal);
    expect(brick2).toBeNull();
    expect(store.save).toHaveBeenCalledTimes(1); // no additional save
  });

  test("allows synthesis for different tools", async () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      clock: () => 1_700_000_000_000,
    });

    const signal1 = createDemandSignal();
    const signal2 = createDemandSignal({
      id: "demand-2",
      trigger: { kind: "repeated_failure", toolName: "write_file", count: 5 },
    });

    const brick1 = await stack.synthesizeHarness(signal1);
    const brick2 = await stack.synthesizeHarness(signal2);

    expect(brick1).not.toBeNull();
    expect(brick2).not.toBeNull();
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  test("deduplicates identical failure descriptions via stable errorCodes", async () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      clock: () => 1_700_000_000_000,
    });

    // 5 identical failures — should dedup to 1, which is below minFailures (3)
    const signal = createDemandSignal({
      context: {
        failureCount: 5,
        failedToolCalls: [
          "search: Missing query parameter",
          "search: Missing query parameter",
          "search: Missing query parameter",
          "search: Missing query parameter",
          "search: Missing query parameter",
        ],
      },
      emittedAt: 1_700_000_000_000,
    });

    const brick = await stack.synthesizeHarness(signal);
    // Aggregator deduplicates to 1 distinct failure, below minFailures threshold
    expect(brick).toBeNull();
    expect(store.save).not.toHaveBeenCalled();
  });

  test("respects custom maxSynthesesPerSession", () => {
    const store = createMockForgeStore();
    const stack = createAutoHarnessStack({
      forgeStore: store,
      generate: async () => LLM_RESPONSE,
      maxSynthesesPerSession: 10,
    });

    expect(stack.maxSynthesesPerSession).toBe(10);
  });
});
