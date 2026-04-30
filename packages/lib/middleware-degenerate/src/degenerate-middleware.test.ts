import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  DegeneracyConfig,
  ForgeStore,
  ToolHandler,
  ToolRequest,
  VariantAttempt,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
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
  test("rejects context-match strategy at construction (no contextMatcher hook yet)", () => {
    const bricks = [makeBrick("b1", "search-api", 0.9)];
    const handlers = new Map<string, ToolHandler>();
    const config = makeConfig(bricks, handlers);
    const ctxConfig: DegenerateMiddlewareConfig = {
      ...config,
      capabilityConfigs: new Map([
        ["search", { ...DEFAULT_CONFIG, selectionStrategy: "context-match" }],
      ]),
    };
    expect(() => createDegenerateMiddleware(ctxConfig)).toThrow(/context-match/);
  });

  test("middleware has correct name and priority", () => {
    const handlers = new Map<string, ToolHandler>();
    const config = makeConfig([], handlers);
    const handle = createDegenerateMiddleware(config);
    expect(handle.middleware.name).toBe("degenerate");
    expect(handle.middleware.priority).toBe(1_000);
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

  test("factory rejects empty capabilityConfigs (fails closed instead of inert no-op)", () => {
    // A manifest mistake that produces zero capability configs must
    // not silently disable the redundancy layer. The factory throws
    // VALIDATION at construction so the runtime cannot start without
    // operator awareness.
    const config = makeConfig([], new Map(), { capabilityConfigs: new Map() });
    expect(() => createDegenerateMiddleware(config)).toThrow(/at least one capability config/);
  });

  test("describeCapabilities returns fragment when pools exist", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9)];
    const config = makeConfig(bricks, new Map());
    const handle = createDegenerateMiddleware(config);

    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const fragment = handle.middleware.describeCapabilities?.(makeTurnCtx());
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

  test("broken createToolExecutor on one variant does not abort session start", async () => {
    const bricks = [
      makeBrick("b1", "search-api", 0.9),
      makeBrick("b2", "search-scrape", 0.5),
      makeBrick("b3", "search-cache", 0.3),
    ];
    const handlers = new Map<string, ToolHandler>([
      ["b1", async () => ({ output: "ok-b1" })],
      ["b3", async () => ({ output: "ok-b3" })],
    ]);
    const config: DegenerateMiddlewareConfig = {
      forgeStore: makeForgeStore(bricks),
      createToolExecutor: async (brick) => {
        if (brick.id === "b2") {
          throw new Error("missing dep");
        }
        const h = handlers.get(brick.id);
        if (h === undefined) throw new Error(`no handler for ${brick.id}`);
        return h;
      },
      capabilityConfigs: new Map([["search", DEFAULT_CONFIG]]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);

    // Must not throw — broken b2 skipped, b1 + b3 survive (>= minVariants=1).
    await handle.middleware.onSessionStart?.(makeSessionCtx());
    const pool = handle.getVariantPool("search");
    expect(pool).toBeDefined();
    expect(pool?.variants.length).toBe(2);
    expect(pool?.variants.map((v) => v.id).sort()).toEqual(["b1", "b3"]);
  });

  test("broken bricks within the candidate window are skipped; healthy peers populate the pool", async () => {
    const bricks = [
      makeBrick("b-top-broken", "search-top", 0.95),
      makeBrick("b-mid-broken", "search-mid", 0.85),
      makeBrick("b-low-ok", "search-low", 0.5),
    ];
    const handlers = new Map<string, ToolHandler>([
      ["b-low-ok", async () => ({ output: "ok-low" })],
    ]);
    const config: DegenerateMiddlewareConfig = {
      forgeStore: makeForgeStore(bricks),
      createToolExecutor: async (brick) => {
        const h = handlers.get(brick.id);
        if (h === undefined) throw new Error(`broken: ${brick.id}`);
        return h;
      },
      capabilityConfigs: new Map([
        // maxVariants=3 admits all three bricks into the candidate window.
        [
          "search",
          { selectionStrategy: "fitness", minVariants: 1, maxVariants: 3, failoverEnabled: true },
        ],
      ]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    // Within the candidate window, broken bricks are skipped and the
    // healthy lower-ranked peer survives. minVariants=1 is satisfied.
    const pool = handle.getVariantPool("search");
    expect(pool).toBeDefined();
    expect(pool?.variants.length).toBe(1);
    expect(pool?.variants[0]?.id).toBe("b-low-ok");
  });

  test("broken aliases do NOT claim capability routing (fail-closed for failoverEnabled=false)", async () => {
    const bricks = [
      makeBrick("b-broken", "search-api", 0.9),
      makeBrick("b-ok", "search-cache", 0.5),
    ];
    const handlers = new Map<string, ToolHandler>([["b-ok", async () => ({ output: "ok" })]]);
    const config: DegenerateMiddlewareConfig = {
      forgeStore: makeForgeStore(bricks),
      createToolExecutor: async (brick) => {
        const h = handlers.get(brick.id);
        if (h === undefined) throw new Error(`broken: ${brick.id}`);
        return h;
      },
      capabilityConfigs: new Map([
        // failoverEnabled: false — explicitly forbids cross-variant substitution.
        [
          "search",
          { selectionStrategy: "fitness", minVariants: 1, maxVariants: 3, failoverEnabled: false },
        ],
      ]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    // The broken alias was NOT registered (executor build failed). A call
    // addressed to `search-api` must pass through to next() — not be
    // silently rerouted to the surviving b-ok variant.
    const next: ToolHandler = async (req) => ({ output: `passthrough:${req.toolId}` });
    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-api"),
      next,
    );
    expect(response?.output).toBe("passthrough:search-api");
  });

  test("broken aliases DO claim capability routing under failoverEnabled=true so failover saves them", async () => {
    // Two candidates: the high-fitness primary fails to hydrate, the
    // peer survives. A call addressed to the broken primary alias must
    // still enter degeneracy (not pass through) and be served by the
    // healthy peer — otherwise partial startup failure becomes a
    // user-visible hard failure for whichever alias the model picks.
    const bricks = [
      makeBrick("b-broken", "search-api", 0.9),
      makeBrick("b-ok", "search-cache", 0.5),
    ];
    const handlers = new Map<string, ToolHandler>([["b-ok", async () => ({ output: "served" })]]);
    const config: DegenerateMiddlewareConfig = {
      forgeStore: makeForgeStore(bricks),
      createToolExecutor: async (brick) => {
        const h = handlers.get(brick.id);
        if (h === undefined) throw new Error(`broken: ${brick.id}`);
        return h;
      },
      capabilityConfigs: new Map([
        [
          "search",
          { selectionStrategy: "fitness", minVariants: 1, maxVariants: 3, failoverEnabled: true },
        ],
      ]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const next: ToolHandler = async () => ({ output: "should-not-be-called" });
    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-api"),
      next,
    );
    expect(response?.output).toBe("served");
  });

  test("explicit alias pinning is deterministic when randomFn returns 0", async () => {
    // Pinning must not depend on weighted-random math: an RNG returning
    // 0 with `Infinity` weight produces NaN comparisons and silently
    // falls through to a non-pinned variant. Round-robin-based pinning
    // sidesteps this; addressing a specific alias must always run that
    // variant first.
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.1)];
    const calls: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      [
        "b1",
        async () => {
          calls.push("b1");
          return { output: "b1" };
        },
      ],
      [
        "b2",
        async () => {
          calls.push("b2");
          return { output: "b2" };
        },
      ],
    ]);
    const config = makeConfig(bricks, handlers, { random: () => 0 });
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-scrape"),
      async () => ({ output: "n/a" }),
    );
    expect(response?.output).toBe("b2");
    expect(calls[0]).toBe("b2");
  });

  test("explicit alias pinning: low-fitness alias still executes first when addressed", async () => {
    // The model addresses the low-fitness alias `search-scrape`. Even
    // though `search-api` has higher fitness and `selectByFitness`
    // would otherwise pick it, the explicit alias must execute first.
    // Strategy-based selection only picks among the rest as failover.
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.1)];
    let observedFirst = "";
    const handlers = new Map<string, ToolHandler>([
      [
        "b1",
        async (req) => {
          if (observedFirst === "") observedFirst = `b1:${req.toolId}`;
          return { output: "b1" };
        },
      ],
      [
        "b2",
        async (req) => {
          if (observedFirst === "") observedFirst = `b2:${req.toolId}`;
          return { output: "b2" };
        },
      ],
    ]);
    const config = makeConfig(bricks, handlers);
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-scrape"),
      async () => ({ output: "n/a" }),
    );
    expect(response?.output).toBe("b2");
    expect(observedFirst).toBe("b2:search-scrape");
  });

  test("session start rejects duplicate brick aliases within the same capability", async () => {
    // Two bricks in the same capability share the alias "search-api".
    // Without rejection, the reverse alias→variantId map would let the
    // last duplicate silently win, so an addressed alias could execute
    // a different variant than intended.
    const bricks = [
      makeBrick("b-first", "search-api", 0.9),
      makeBrick("b-second", "search-api", 0.8),
    ];
    const handlers = new Map<string, ToolHandler>([
      ["b-first", async () => ({ output: "first" })],
      ["b-second", async () => ({ output: "second" })],
    ]);
    const config = makeConfig(bricks, handlers);
    const handle = createDegenerateMiddleware(config);
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/already claimed within capability/);
  });

  test("session start rejects duplicate brick aliases across capabilities", async () => {
    // Two capabilities each contain a brick claiming alias "lookup".
    // Without rejection, the later pool would silently overwrite the
    // earlier one in toolToCapability and route calls into the wrong
    // capability with the wrong policy/audit.
    const collidingStore: ForgeStore = {
      search: mock(async (q: { tags: string[] }) => {
        const cap = q.tags[0]?.replace("capability:", "") ?? "";
        return {
          ok: true as const,
          value: [makeBrick(`b-${cap}`, "lookup", 0.5)],
        };
      }),
      save: mock(async () => ({ ok: true as const, value: undefined })),
      load: mock(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND", message: "n/a", retryable: false },
      })),
      remove: mock(async () => ({ ok: true as const, value: undefined })),
      update: mock(async () => ({ ok: true as const, value: undefined })),
      exists: mock(async () => false),
      promote: mock(async () => ({ ok: true as const, value: undefined })),
    } as unknown as ForgeStore;
    const config: DegenerateMiddlewareConfig = {
      forgeStore: collidingStore,
      createToolExecutor: async () => async () => ({ output: "ok" }),
      capabilityConfigs: new Map([
        ["search", DEFAULT_CONFIG],
        ["translate", DEFAULT_CONFIG],
      ]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/already claimed|alias.*collision|cross-capability/i);
  });

  test("alternate-variant dispatch preserves the public alias on toolId and surfaces variant identity in metadata", async () => {
    // Outer middleware (permissions, audit, provenance) keys on
    // request.toolId — the caller-addressed public alias. All variants
    // in a degenerate pool share that authorization scope by contract.
    // Variant identity is observable via metadata for executors and
    // observability sinks that care about which specific variant ran.
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    let observedToolId = "";
    let observedMeta: Record<string, unknown> | undefined;
    const handlers = new Map<string, ToolHandler>([
      [
        "b1",
        async () => {
          throw new Error("b1 down");
        },
      ],
      [
        "b2",
        async (req) => {
          observedToolId = req.toolId;
          observedMeta = req.metadata as Record<string, unknown> | undefined;
          return { output: "ok" };
        },
      ],
    ]);
    const config = makeConfig(bricks, handlers);
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const response = await handle.middleware.wrapToolCall?.(
      makeTurnCtx(),
      makeRequest("search-api"),
      async () => ({ output: "n/a" }),
    );
    expect(response?.output).toBe("ok");
    expect(observedToolId).toBe("search-api");
    expect(observedMeta?.publicAlias).toBe("search-api");
    expect(observedMeta?.selectedVariantId).toBe("b2");
    expect(observedMeta?.selectedVariantAlias).toBe("search-scrape");
  });

  test("session start fails loudly on non-retryable ForgeStore search errors", async () => {
    const failingForgeStore: ForgeStore = {
      search: mock(async () => ({
        ok: false as const,
        // retryable=false → contract/config failure, must not silently degrade.
        error: { code: "INTERNAL", message: "schema mismatch", retryable: false },
      })),
      save: mock(async () => ({ ok: true as const, value: undefined })),
      load: mock(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND", message: "n/a", retryable: false },
      })),
      remove: mock(async () => ({ ok: true as const, value: undefined })),
      update: mock(async () => ({ ok: true as const, value: undefined })),
      exists: mock(async () => false),
      promote: mock(async () => ({ ok: true as const, value: undefined })),
    } as unknown as ForgeStore;
    const config: DegenerateMiddlewareConfig = {
      forgeStore: failingForgeStore,
      createToolExecutor: () => {
        throw new Error("unused");
      },
      capabilityConfigs: new Map([["search", DEFAULT_CONFIG]]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toContain("schema mismatch");
  });

  test("session start fails loudly on retryable ForgeStore search errors too", async () => {
    // A configured capability that cannot be hydrated must not silently
    // disappear. Even retryable store errors fail session start so the
    // operator sees the missing redundancy instead of running with a
    // fail-open hole. Wrappers can decide to retry session start; the
    // error message includes a [retryable] hint.
    const flakyStore: ForgeStore = {
      search: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL", message: "transient blip", retryable: true },
      })),
      save: mock(async () => ({ ok: true as const, value: undefined })),
      load: mock(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND", message: "n/a", retryable: false },
      })),
      remove: mock(async () => ({ ok: true as const, value: undefined })),
      update: mock(async () => ({ ok: true as const, value: undefined })),
      exists: mock(async () => false),
      promote: mock(async () => ({ ok: true as const, value: undefined })),
    } as unknown as ForgeStore;
    const config: DegenerateMiddlewareConfig = {
      forgeStore: flakyStore,
      createToolExecutor: async () => async () => ({ output: "n/a" }),
      capabilityConfigs: new Map([["search", DEFAULT_CONFIG]]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("transient blip");
    expect(String(caught)).toContain("[retryable]");
  });

  test("session start fails when configured capability has zero discovered variants", async () => {
    // Empty result set is observationally identical to a missing
    // capability — must reach minVariants enforcement, not silently
    // disable the pool.
    const emptyStore: ForgeStore = {
      search: mock(async () => ({ ok: true as const, value: [] })),
      save: mock(async () => ({ ok: true as const, value: undefined })),
      load: mock(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND", message: "n/a", retryable: false },
      })),
      remove: mock(async () => ({ ok: true as const, value: undefined })),
      update: mock(async () => ({ ok: true as const, value: undefined })),
      exists: mock(async () => false),
      promote: mock(async () => ({ ok: true as const, value: undefined })),
    } as unknown as ForgeStore;
    const config: DegenerateMiddlewareConfig = {
      forgeStore: emptyStore,
      createToolExecutor: async () => async () => ({ output: "n/a" }),
      capabilityConfigs: new Map([["search", DEFAULT_CONFIG]]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/minVariants/);
  });

  test("attempt outcomes accumulate across calls (thompson state persistence path)", async () => {
    // Round-robin guarantees both variants get attempted, so both
    // success and failure outcomes feed the per-call thompson update
    // pass. Without per-session thompson state, the update would be a
    // no-op; this test exercises the persistence path itself.
    const bricks = [makeBrick("b1", "search-api", 0.5), makeBrick("b2", "search-scrape", 0.5)];
    const handlers = new Map<string, ToolHandler>([
      ["b1", async () => ({ output: "ok" })],
      [
        "b2",
        async () => {
          throw new Error("b2 down");
        },
      ],
    ]);
    const config = makeConfig(bricks, handlers, {
      capabilityConfigs: new Map([
        [
          "search",
          {
            selectionStrategy: "round-robin",
            minVariants: 1,
            maxVariants: 3,
            failoverEnabled: true,
          },
        ],
      ]),
    });
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    // Alternate between aliases so explicit alias pinning exercises
    // both a healthy variant (b1) and the broken one (b2). When the
    // model addresses "search-scrape" first, b2 fails and failover
    // serves b1, producing both success and failure attempts.
    for (let i = 0; i < 4; i++) {
      const alias = i % 2 === 0 ? "search-api" : "search-scrape";
      try {
        await handle.middleware.wrapToolCall?.(makeTurnCtx(), makeRequest(alias), async () => ({
          output: "n/a",
        }));
      } catch {
        // Some attempts fail; we only care about state accumulation.
      }
    }

    const attempts = handle.getAttemptLog("search");
    expect(attempts.length).toBeGreaterThan(1);
    // Both outcomes must appear so the thompson update path was exercised
    // for success AND failure cases.
    expect(attempts.some((a) => a.success)).toBe(true);
    expect(attempts.some((a) => !a.success)).toBe(true);
  });

  test("attemptLog is bounded across many calls (no unbounded growth)", async () => {
    // Long-lived sessions with frequent failover must not accumulate an
    // unbounded attempt history per capability — that would turn a
    // resilience feature into a memory/CPU regression. The retained
    // window is capped at 256 entries.
    const bricks = [makeBrick("b1", "search-api", 0.9)];
    const handlers = new Map<string, ToolHandler>([["b1", async () => ({ output: "ok" })]]);
    const config = makeConfig(bricks, handlers);
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    for (let i = 0; i < 1_000; i++) {
      await handle.middleware.wrapToolCall?.(
        makeTurnCtx(),
        makeRequest("search-api"),
        async () => ({ output: "n/a" }),
      );
    }
    const log = handle.getAttemptLog("search");
    expect(log.length).toBeLessThanOrEqual(256);
    expect(log.length).toBeGreaterThan(0);
  });

  test("session start fails when surviving variants fall below minVariants", async () => {
    const bricks = [makeBrick("b1", "search-api", 0.9), makeBrick("b2", "search-scrape", 0.5)];
    const config: DegenerateMiddlewareConfig = {
      forgeStore: makeForgeStore(bricks),
      createToolExecutor: async () => {
        throw new Error("all variants broken");
      },
      capabilityConfigs: new Map([
        [
          "search",
          { selectionStrategy: "fitness", minVariants: 2, maxVariants: 3, failoverEnabled: true },
        ],
      ]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);

    // 0 usable variants < minVariants=2 — must fail loudly with diagnostic.
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toContain("minVariants");
  });

  test("rejects pool with divergent policy envelopes (regression: failover trust-boundary bypass)", async () => {
    // Failover keeps the caller-addressed alias as the public toolId, so
    // downstream auth/audit middleware sees ONE identity for the pool. If
    // two variants diverge in sandbox/network/permission envelope, a
    // request authorized as the alias would silently execute a brick
    // operating under different trust assumptions. Pool build must reject
    // divergent policies at session start instead of letting failover
    // silently widen the alias's effective scope.
    const sandboxed: BrickArtifact = makeBrick("b1", "search-api", 0.9);
    const unsandboxedBase: BrickArtifact = makeBrick("b2", "search-api-2", 0.8);
    const unsandboxed: BrickArtifact = {
      ...unsandboxedBase,
      policy: DEFAULT_UNSANDBOXED_POLICY,
    } as BrickArtifact;
    const handle = createDegenerateMiddleware(
      makeConfig([sandboxed, unsandboxed], new Map(), {
        capabilityConfigs: new Map([
          [
            "search",
            { selectionStrategy: "fitness", minVariants: 1, maxVariants: 3, failoverEnabled: true },
          ],
        ]),
      }),
    );
    let caught: unknown;
    try {
      await handle.middleware.onSessionStart?.(makeSessionCtx());
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toMatch(/policy envelope|diverg/i);
  });

  test("backfill: top-N bricks broken with maxVariants=N still populates pool from lower ranks", async () => {
    // Regression: stale top-ranked bricks must not strand healthy lower-
    // ranked variants below the cutoff. Build window walks the full ranked
    // list until maxVariants USABLE entries are found.
    const bricks = [
      makeBrick("b1-broken", "search-1", 0.95),
      makeBrick("b2-broken", "search-2", 0.85),
      makeBrick("b3-ok", "search-3", 0.7),
      makeBrick("b4-ok", "search-4", 0.6),
      makeBrick("b5-ok", "search-5", 0.5),
    ];
    const handlers = new Map<string, ToolHandler>([
      ["b3-ok", async () => ({ output: "from-3" })],
      ["b4-ok", async () => ({ output: "from-4" })],
      ["b5-ok", async () => ({ output: "from-5" })],
    ]);
    const config: DegenerateMiddlewareConfig = {
      forgeStore: makeForgeStore(bricks),
      createToolExecutor: async (brick) => {
        const h = handlers.get(brick.id);
        if (h === undefined) throw new Error(`broken: ${brick.id}`);
        return h;
      },
      capabilityConfigs: new Map([
        [
          "search",
          { selectionStrategy: "fitness", minVariants: 2, maxVariants: 2, failoverEnabled: true },
        ],
      ]),
      clock: () => now,
      random: () => 0.1,
    };
    const handle = createDegenerateMiddleware(config);
    await handle.middleware.onSessionStart?.(makeSessionCtx());

    const pool = handle.getVariantPool("search");
    expect(pool).toBeDefined();
    expect(pool?.variants.length).toBe(2);
    // Pool contains ranks #3 and #4 (next two healthy after the broken pair) —
    // not stops-at-#2 because #1 and #2 were broken.
    expect(pool?.variants.map((v) => v.id).sort()).toEqual(["b3-ok", "b4-ok"]);
  });
});
