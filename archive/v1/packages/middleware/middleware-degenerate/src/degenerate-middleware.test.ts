import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  DegeneracyConfig,
  ForgeStore,
  ToolHandler,
  ToolRequest,
  VariantAttempt,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { createDegenerateMiddleware } from "./degenerate-middleware.js";
import type { DegenerateMiddlewareConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "fitness",
  minVariants: 1,
  maxVariants: 3,
  failoverEnabled: true,
};

function makeBrick(id: string, name: string, fitness: number): BrickArtifact {
  return {
    kind: "tool",
    id,
    name,
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    tags: [`capability:search`],
    fitness: {
      successCount: Math.round(fitness * 100),
      errorCount: Math.round((1 - fitness) * 10),
      latency: { samples: [], count: 0, cap: 200 },
      lastUsedAt: Date.now(),
    },
  } as unknown as BrickArtifact;
}

function makeForgeStore(bricks: readonly BrickArtifact[]): ForgeStore {
  return {
    search: mock(async () => ({ ok: true as const, value: [...bricks] })),
    save: mock(async () => ({ ok: true as const, value: undefined })),
    load: mock(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND", message: "not found", retryable: false },
    })),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async () => ({ ok: true as const, value: undefined })),
    exists: mock(async () => false),
    promote: mock(async () => ({ ok: true as const, value: undefined })),
  } as unknown as ForgeStore;
}

function makeRequest(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

function makeSessionCtx() {
  return {
    agentId: "test-agent",
    sessionId: "test-session" as never,
    runId: "test-run" as never,
    metadata: {},
  };
}

function makeTurnCtx() {
  return {
    session: makeSessionCtx(),
    turnIndex: 0,
    turnId: "test-turn" as never,
    messages: [],
    metadata: {},
  };
}

const now = 1000;

function makeConfig(
  bricks: readonly BrickArtifact[],
  handlers: ReadonlyMap<string, ToolHandler>,
  overrides?: Partial<DegenerateMiddlewareConfig>,
): DegenerateMiddlewareConfig {
  return {
    forgeStore: makeForgeStore(bricks),
    createToolExecutor: async (brick) => {
      const handler = handlers.get(brick.id);
      if (handler === undefined) {
        return async () => ({ output: `default-${brick.name}` });
      }
      return handler;
    },
    capabilityConfigs: new Map([["search", DEFAULT_CONFIG]]),
    clock: () => now,
    random: () => 0.1, // deterministic
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDegenerateMiddleware", () => {
  test("middleware has correct name and priority", () => {
    const handlers = new Map<string, ToolHandler>();
    const config = makeConfig([], handlers);
    const handle = createDegenerateMiddleware(config);
    expect(handle.middleware.name).toBe("degenerate");
    expect(handle.middleware.priority).toBe(460);
  });

  test("passes through non-degenerate tools", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9)];
    const handlers = new Map<string, ToolHandler>();
    const config = makeConfig(bricks, handlers);
    const handle = createDegenerateMiddleware(config);

    // Initialize pools
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const next: ToolHandler = async (req) => ({ output: `passed-${req.toolId}` });
    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("unknown-tool"),
      next,
    );
    expect(response?.output).toBe("passed-unknown-tool");
  });

  test("primary succeeds — no failover", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    const handlers = new Map<string, ToolHandler>([
      ["b1", async () => ({ output: "api-result" })],
      ["b2", async () => ({ output: "scrape-result" })],
    ]);
    const config = makeConfig(bricks, handlers);
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const next: ToolHandler = async () => ({ output: "chain-result" });
    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-api"),
      next,
    );

    expect(response).toBeDefined();
    const attempts = handle.getAttemptLog("search");
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.success).toBe(true);
  });

  test("primary fails, alternative succeeds — failover works", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    const handlers = new Map<string, ToolHandler>([
      [
        "b1",
        async () => {
          throw new Error("api down");
        },
      ],
      ["b2", async () => ({ output: "scrape-result" })],
    ]);
    const failoverCalls: Array<{ attempt: VariantAttempt; nextId: string }> = [];
    const config = makeConfig(bricks, handlers, {
      onFailover: (attempt, nextId) => failoverCalls.push({ attempt, nextId }),
    });
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    // Both variants route through next() with variant.id as toolId.
    // Primary (b1) fails, failover (b2) succeeds.
    const next: ToolHandler = async (req) => {
      if (req.toolId === "b1") {
        throw new Error("api down");
      }
      return { output: "scrape-result" };
    };
    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-api"),
      next,
    );

    expect(response).toBeDefined();
    const attempts = handle.getAttemptLog("search");
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.success).toBe(false);
    expect(attempts[1]?.success).toBe(true);
    expect(failoverCalls.length).toBeGreaterThan(0);
  });

  test("all variants fail — throws last error", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    const handlers = new Map<string, ToolHandler>([
      [
        "b1",
        async () => {
          throw new Error("api down");
        },
      ],
      [
        "b2",
        async () => {
          throw new Error("scrape down");
        },
      ],
    ]);
    const allFailedCalls: Array<{ capability: string; attempts: readonly VariantAttempt[] }> = [];
    const config = makeConfig(bricks, handlers, {
      onAllVariantsFailed: (cap, att) => allFailedCalls.push({ capability: cap, attempts: att }),
    });
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const next: ToolHandler = async () => {
      throw new Error("api down");
    };

    await expect(
      handle.middleware.wrapToolCall?.(makeTurnCtx(), makeRequest("search-api"), next),
    ).rejects.toThrow();

    expect(allFailedCalls.length).toBe(1);
    expect(allFailedCalls[0]?.capability).toBe("search");
  });

  test("failover disabled — primary failure is final", async () => {
    const noFailoverConfig: DegeneracyConfig = {
      ...DEFAULT_CONFIG,
      failoverEnabled: false,
    };
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    const handlers = new Map<string, ToolHandler>([
      [
        "b1",
        async () => {
          throw new Error("api down");
        },
      ],
      ["b2", async () => ({ output: "scrape-result" })],
    ]);
    const config = makeConfig(bricks, handlers, {
      capabilityConfigs: new Map([["search", noFailoverConfig]]),
    });
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const next: ToolHandler = async () => {
      throw new Error("api down");
    };

    await expect(
      handle.middleware.wrapToolCall?.(makeTurnCtx(), makeRequest("search-api"), next),
    ).rejects.toThrow("api down");

    const attempts = handle.getAttemptLog("search");
    expect(attempts.length).toBe(1);
  });

  test("variant pool is empty — passes through to next()", async () => {
    const config = makeConfig([], new Map(), {
      capabilityConfigs: new Map([["search", DEFAULT_CONFIG]]),
    });
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const next: ToolHandler = async (req) => ({ output: `passed-${req.toolId}` });
    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-api"),
      next,
    );
    expect(response?.output).toBe("passed-search-api");
  });

  test("describeCapabilities returns undefined when no pools", async () => {
    const config = makeConfig([], new Map());
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const fragment = handle.middleware.describeCapabilities(makeTurnCtx());
    expect(fragment).toBeUndefined();
  });

  test("describeCapabilities returns fragment when pools exist", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9)];
    const config = makeConfig(bricks, new Map());
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const fragment = handle.middleware.describeCapabilities(makeTurnCtx());
    expect(fragment).toBeDefined();
    expect(fragment?.label).toBe("degeneracy");
  });

  test("onSessionEnd clears all state", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9)];
    const config = makeConfig(bricks, new Map());
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());
    expect(handle.getVariantPool("search")).toBeDefined();

    await handle.middleware.onSessionEnd?.(makeSessionCtx());
    expect(handle.getVariantPool("search")).toBeUndefined();
    expect(handle.getAttemptLog("search")).toHaveLength(0);
  });

  test("getVariantPool returns pool for known capability", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    const config = makeConfig(bricks, new Map());
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const pool = handle.getVariantPool("search");
    expect(pool).toBeDefined();
    expect(pool?.variants.length).toBe(2);
  });
});
