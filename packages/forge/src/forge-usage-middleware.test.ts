import { describe, expect, mock, test } from "bun:test";
import type { StoreChangeEvent, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createDefaultForgeConfig } from "./config.js";
import { createForgeUsageMiddleware } from "./forge-usage-middleware.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import { createMemoryStoreChangeNotifier } from "./store-notifier.js";
import type { ToolArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId(`brick_${crypto.randomUUID()}`),
    kind: "tool",
    name: "calc",
    description: "A calculator",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return input.a + input.b;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function stubTurnContext(): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "sess_1" as TurnContext["session"]["sessionId"],
      runId: "run_1" as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn_1" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

/** Safely extract wrapToolCall from middleware (always defined for usage middleware). */
function getWrapToolCall(
  mw: ReturnType<typeof createForgeUsageMiddleware>,
): NonNullable<ReturnType<typeof createForgeUsageMiddleware>["wrapToolCall"]> {
  const wrap = mw.wrapToolCall;
  if (wrap === undefined) throw new Error("wrapToolCall unexpectedly undefined");
  return wrap;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeUsageMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createForgeUsageMiddleware({
      store: createInMemoryForgeStore(),
      config: createDefaultForgeConfig(),
      resolveBrickId: () => undefined,
    });

    expect(mw.name).toBe("forge-usage");
    expect(mw.priority).toBe(900);
  });

  test("records usage for forged tool after successful call", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick({ id: brickId("brick_calc"), name: "calc" });
    await store.save(brick);

    const mw = createForgeUsageMiddleware({
      store,
      config: createDefaultForgeConfig(),
      resolveBrickId: (name) => (name === "calc" ? "brick_calc" : undefined),
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: 42,
    });

    const ctx = stubTurnContext();
    const request: ToolRequest = { toolId: "calc", input: { a: 1, b: 2 } };

    const response = await getWrapToolCall(mw)(ctx, request, next);
    expect(response.output).toBe(42);

    // Allow fire-and-forget to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const loaded = await store.load(brickId("brick_calc"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.usageCount).toBe(1);
    }
  });

  test("skips non-forged tools silently", async () => {
    const store = createInMemoryForgeStore();

    const mw = createForgeUsageMiddleware({
      store,
      config: createDefaultForgeConfig(),
      resolveBrickId: () => undefined,
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });

    const ctx = stubTurnContext();
    const request: ToolRequest = { toolId: "native_tool", input: {} };

    const response = await getWrapToolCall(mw)(ctx, request, next);
    expect(response.output).toBe("ok");
  });

  test("propagates tool call errors and records failure in fitness", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick({ id: brickId("brick_fail"), name: "fail_tool" });
    await store.save(brick);

    const mw = createForgeUsageMiddleware({
      store,
      config: createDefaultForgeConfig(),
      resolveBrickId: (name) => (name === "fail_tool" ? "brick_fail" : undefined),
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => {
      throw new Error("Tool execution failed");
    };

    const ctx = stubTurnContext();
    const request: ToolRequest = { toolId: "fail_tool", input: {} };

    await expect(getWrapToolCall(mw)(ctx, request, next)).rejects.toThrow("Tool execution failed");

    // Allow fire-and-forget to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Usage IS recorded for failed calls (as error in fitness)
    const loaded = await store.load(brickId("brick_fail"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.usageCount).toBe(1);
      expect(loaded.value.fitness).toBeDefined();
      expect(loaded.value.fitness?.errorCount).toBe(1);
      expect(loaded.value.fitness?.successCount).toBe(0);
    }
  });

  test("calls onUsageError when recording fails", async () => {
    const failingStore = {
      save: async () => ({ ok: true as const, value: undefined }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
      search: async () => ({
        ok: true as const,
        value: [] as readonly never[],
      }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
    };

    const onUsageError = mock((_toolName: string, _brickId: string, _error: unknown) => {});

    const mw = createForgeUsageMiddleware({
      store: failingStore,
      config: createDefaultForgeConfig(),
      resolveBrickId: (name) => (name === "calc" ? "brick_calc" : undefined),
      onUsageError,
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: 42,
    });

    const ctx = stubTurnContext();
    const request: ToolRequest = { toolId: "calc", input: {} };

    // Tool call should still succeed
    const response = await getWrapToolCall(mw)(ctx, request, next);
    expect(response.output).toBe(42);

    // Allow fire-and-forget to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Error handler should have been called
    expect(onUsageError).toHaveBeenCalled();
    expect(onUsageError.mock.calls[0]?.[0]).toBe("calc");
    expect(onUsageError.mock.calls[0]?.[1]).toBe("brick_calc");
  });

  test("auto-promotes brick when threshold is crossed", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick({
      id: brickId("brick_promo"),
      name: "promo_tool",
      trustTier: "sandbox",
      usageCount: 4, // One more will cross the threshold
      fitness: {
        successCount: 4,
        errorCount: 0,
        latency: { samples: [50, 60, 70, 80], count: 4, cap: 200 },
        lastUsedAt: Date.now() - 1000,
      },
    });
    await store.save(brick);

    const config = createDefaultForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 5,
        verifiedToPromotedThreshold: 20,
      },
    });

    const mw = createForgeUsageMiddleware({
      store,
      config,
      resolveBrickId: (name) => (name === "promo_tool" ? "brick_promo" : undefined),
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });

    const ctx = stubTurnContext();
    const request: ToolRequest = { toolId: "promo_tool", input: {} };

    await getWrapToolCall(mw)(ctx, request, next);

    // Allow fire-and-forget to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const loaded = await store.load(brickId("brick_promo"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.usageCount).toBe(5);
      expect(loaded.value.trustTier).toBe("verified");
    }
  });

  test("fires 'updated' notification after successful usage recording", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick({
      id: brickId("brick_notify"),
      name: "notify_tool",
      usageCount: 0,
    });
    await store.save(brick);

    const notifier = createMemoryStoreChangeNotifier();
    const events: StoreChangeEvent[] = [];
    notifier.subscribe((event) => events.push(event));

    const mw = createForgeUsageMiddleware({
      store,
      config: createDefaultForgeConfig(),
      resolveBrickId: (name) => (name === "notify_tool" ? "brick_notify" : undefined),
      notifier,
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
      output: "ok",
    });

    const ctx = stubTurnContext();
    await getWrapToolCall(mw)(ctx, { toolId: "notify_tool", input: {} }, next);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("updated");
    expect(events[0]?.brickId).toBe(brickId("brick_notify"));
  });

  test("does not notify when usage recording fails", async () => {
    const failingStore = {
      save: async () => ({ ok: true as const, value: undefined }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
      search: async () => ({ ok: true as const, value: [] as readonly never[] }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
    };

    const notifier = createMemoryStoreChangeNotifier();
    const events: StoreChangeEvent[] = [];
    notifier.subscribe((event) => events.push(event));

    const mw = createForgeUsageMiddleware({
      store: failingStore,
      config: createDefaultForgeConfig(),
      resolveBrickId: (name) => (name === "calc" ? "brick_calc" : undefined),
      notifier,
      onUsageError: () => {},
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: 42 });

    const ctx = stubTurnContext();
    await getWrapToolCall(mw)(ctx, { toolId: "calc", input: {} }, next);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // No notification because recording failed
    expect(events.length).toBe(0);
  });

  test("does not notify for non-forged tools", async () => {
    const notifier = createMemoryStoreChangeNotifier();
    const events: StoreChangeEvent[] = [];
    notifier.subscribe((event) => events.push(event));

    const mw = createForgeUsageMiddleware({
      store: createInMemoryForgeStore(),
      config: createDefaultForgeConfig(),
      resolveBrickId: () => undefined,
      notifier,
    });

    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });

    const ctx = stubTurnContext();
    await getWrapToolCall(mw)(ctx, { toolId: "native_tool", input: {} }, next);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.length).toBe(0);
  });

  describe("fitness tracking", () => {
    test("records success with fitness metrics after successful call", async () => {
      const store = createInMemoryForgeStore();
      const brick = createToolBrick({ id: brickId("brick_fit"), name: "fit_tool" });
      await store.save(brick);

      const mw = createForgeUsageMiddleware({
        store,
        config: createDefaultForgeConfig(),
        resolveBrickId: (name) => (name === "fit_tool" ? "brick_fit" : undefined),
      });

      const next = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
      const ctx = stubTurnContext();
      await getWrapToolCall(mw)(ctx, { toolId: "fit_tool", input: {} }, next);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const loaded = await store.load(brickId("brick_fit"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.fitness).toBeDefined();
        expect(loaded.value.fitness?.successCount).toBe(1);
        expect(loaded.value.fitness?.errorCount).toBe(0);
        expect(loaded.value.fitness?.latency.count).toBe(1);
        expect(loaded.value.fitness?.lastUsedAt).toBeGreaterThan(0);
      }
    });

    test("records latency in fitness metrics", async () => {
      const store = createInMemoryForgeStore();
      const brick = createToolBrick({ id: brickId("brick_lat"), name: "lat_tool" });
      await store.save(brick);

      const mw = createForgeUsageMiddleware({
        store,
        config: createDefaultForgeConfig(),
        resolveBrickId: (name) => (name === "lat_tool" ? "brick_lat" : undefined),
      });

      // Simulate a slow tool call
      const next = async (_req: ToolRequest): Promise<ToolResponse> => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { output: "ok" };
      };

      const ctx = stubTurnContext();
      await getWrapToolCall(mw)(ctx, { toolId: "lat_tool", input: {} }, next);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const loaded = await store.load(brickId("brick_lat"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.fitness?.latency.samples.length).toBe(1);
        // Latency should be at least 20ms (the simulated delay)
        const sample = loaded.value.fitness?.latency.samples[0];
        expect(sample).toBeGreaterThanOrEqual(15); // allow small timing variance
      }
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createForgeUsageMiddleware({
        store: createInMemoryForgeStore(),
        config: createDefaultForgeConfig(),
        resolveBrickId: () => undefined,
      });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'forge-usage' and expected description", () => {
      const mw = createForgeUsageMiddleware({
        store: createInMemoryForgeStore(),
        config: createDefaultForgeConfig(),
        resolveBrickId: () => undefined,
      });
      const ctx = stubTurnContext();
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("forge-usage");
      expect(result?.description).toContain("usage tracking");
    });
  });
});
