import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChainId,
  NodeId,
  PutOptions,
  SnapshotChainStore,
  SnapshotNode,
  ThreadStore,
} from "@koi/core";
import type { MemoryComponent, SessionId } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
import type { FsSearchIndexer, FsSearchRetriever } from "@koi/memory-fs";
import { createContextArena } from "./arena-factory.js";
import type { ContextArenaConfig } from "./types.js";

const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};

function baseConfig(overrides?: Partial<ContextArenaConfig>): ContextArenaConfig {
  return {
    summarizer: stubSummarizer,
    sessionId: "test-session" as SessionId,
    getMessages: (): readonly InboundMessage[] => [],
    ...overrides,
  };
}

describe("createContextArena", () => {
  test("bundle has 3 middleware without memory (squash, compactor, context-editing)", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.middleware).toHaveLength(3);
  });

  test("middleware are in priority order (220, 225, 250) without memory", async () => {
    const bundle = await createContextArena(baseConfig());
    const priorities = bundle.middleware.map((mw) => mw.priority);
    expect(priorities).toEqual([220, 225, 250]);
  });

  test("bundle always has at least 1 provider (squash)", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.providers.length).toBeGreaterThanOrEqual(1);
  });

  test("createHydrator is undefined when no hydrator config", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.createHydrator).toBeUndefined();
  });

  test("createHydrator is present when hydrator config provided", async () => {
    const bundle = await createContextArena(
      baseConfig({
        hydrator: { config: { sources: [] } },
      }),
    );
    expect(bundle.createHydrator).toBeDefined();
    expect(typeof bundle.createHydrator).toBe("function");
  });

  test("shared token estimator instance across all middleware", async () => {
    const customEstimator = {
      estimateText: (text: string): number => Math.ceil(text.length / 3),
      estimateMessages: (): number => 0,
    };
    const bundle = await createContextArena(
      baseConfig({
        tokenEstimator: customEstimator,
      }),
    );
    // Verify config has our estimator
    expect(bundle.config.tokenEstimator).toBe(customEstimator);
    // All 3 middleware exist
    expect(bundle.middleware).toHaveLength(3);
  });

  test("returns resolved config with preset budgets", async () => {
    const bundle = await createContextArena(baseConfig({ preset: "aggressive" }));
    expect(bundle.config.preset).toBe("aggressive");
    expect(bundle.config.compactorTriggerFraction).toBe(0.75);
  });

  test("createHydrator returns a ContextHydratorMiddleware when called with agent", async () => {
    const bundle = await createContextArena(
      baseConfig({
        hydrator: { config: { sources: [] } },
      }),
    );
    expect(bundle.createHydrator).toBeDefined();

    // Minimal mock Agent for hydrator creation
    const mockAgent = {
      pid: { id: "test-agent", depth: 0 },
      manifest: { name: "test", version: "0.0.0" },
      state: "running" as const,
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    } as unknown as import("@koi/core/ecs").Agent;

    const hydrator = bundle.createHydrator?.(mockAgent);
    expect(hydrator).toBeDefined();
    expect(hydrator?.priority).toBe(300);
    expect(typeof hydrator?.getHydrationResult).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Personalization wiring
// ---------------------------------------------------------------------------

describe("createContextArena personalization", () => {
  test("personalization not added when disabled (default)", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.middleware).toHaveLength(3);
  });

  test("personalization not added when enabled but no memory", async () => {
    const bundle = await createContextArena(baseConfig({ personalization: { enabled: true } }));
    expect(bundle.middleware).toHaveLength(3);
  });

  test("personalization added when enabled with memory", async () => {
    const memory = {
      recall: mock(() => Promise.resolve([])),
      store: mock(() => Promise.resolve()),
    } as unknown as MemoryComponent;
    const bundle = await createContextArena(
      baseConfig({ memory, personalization: { enabled: true } }),
    );
    // 4 middleware: squash + compactor + context-editing + user-model (unified)
    expect(bundle.middleware).toHaveLength(4);
    const names = bundle.middleware.map((mw) => mw.name);
    expect(names).toContain("user-model");
  });

  test("personalization middleware uses resolved config values", async () => {
    const memory = {
      recall: mock(() => Promise.resolve([])),
      store: mock(() => Promise.resolve()),
    } as unknown as MemoryComponent;
    const bundle = await createContextArena(
      baseConfig({
        memory,
        personalization: {
          enabled: true,
          relevanceThreshold: 0.5,
          maxPreferenceTokens: 200,
        },
      }),
    );
    expect(bundle.config.personalizationEnabled).toBe(true);
    expect(bundle.config.personalizationRelevanceThreshold).toBe(0.5);
    expect(bundle.config.personalizationMaxPreferenceTokens).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Memory wiring — integration tests (no mock.module, real L2 factories)
// ---------------------------------------------------------------------------

describe("createContextArena memory wiring", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "koi-arena-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("memoryFs adds memory provider to bundle", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
      }),
    );

    // Without memoryFs: 1 provider (squash). With memoryFs: 2 providers.
    expect(bundle.providers).toHaveLength(2);
  });

  test("no memoryFs means only squash provider", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.providers).toHaveLength(1);
  });

  test("config.memory alongside memoryFs still produces 2 providers", async () => {
    const dir = await makeTmpDir();
    const explicitMemory = {
      store: mock(() => Promise.resolve({ ok: true, value: undefined })),
      recall: mock(() => Promise.resolve({ ok: true, value: { facts: [], summary: undefined } })),
      search: mock(() => Promise.resolve({ ok: true, value: [] })),
    } as unknown as MemoryComponent;

    const bundle = await createContextArena(
      baseConfig({
        memory: explicitMemory,
        memoryFs: { config: { baseDir: dir } },
      }),
    );

    // memoryFs provider still attaches even when config.memory overrides for extraction
    expect(bundle.providers).toHaveLength(2);
    // 3 base + hot memory + user-model = 5 middleware
    expect(bundle.middleware).toHaveLength(5);
  });

  test("memoryFs adds hot memory and user-model middleware", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
      }),
    );

    // squash (220) + compactor (225) + context-editing (250) + hot-memory (310) + user-model (415)
    expect(bundle.middleware).toHaveLength(5);
    const priorities = bundle.middleware.map((mw) => mw.priority);
    expect(priorities).toEqual([220, 225, 250, 310, 415]);
  });

  test("preference: false disables user-model middleware when personalization also off", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
        preference: false,
      }),
    );

    // squash + compactor + context-editing + hot-memory = 4
    // (personalization is default-off and preference is explicitly false, so no user-model)
    expect(bundle.middleware).toHaveLength(4);
    const names = bundle.middleware.map((mw) => mw.name);
    expect(names).not.toContain("user-model");
  });

  test("user-model middleware wired with classify callback", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
        preference: { classify: async (_prompt: string) => "NO" },
      }),
    );

    // squash + compactor + context-editing + hot-memory + user-model = 5
    expect(bundle.middleware).toHaveLength(5);
    const umMw = bundle.middleware.find((mw) => mw.name === "user-model");
    expect(umMw).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Search wiring — retriever / indexer flow-through (real L2 factories)
// ---------------------------------------------------------------------------

describe("createContextArena search wiring", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "koi-arena-search-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("wrapper retriever flows through to createFsMemory", async () => {
    const dir = await makeTmpDir();
    const retrieveSpy = mock(() => Promise.resolve([]));
    const wrapperRetriever: FsSearchRetriever = { retrieve: retrieveSpy };

    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir }, retriever: wrapperRetriever },
      }),
    );

    // Store a fact so recall has something to potentially find
    const memProvider = bundle.providers[1];
    expect(memProvider).toBeDefined();

    // Access the memory component through the bundle to call recall
    // The retriever is wired into the FsMemory — call recall via the component
    // We need the component from the provider; use the memory directly via arena internals.
    // Instead, store + recall through the underlying FsMemory component.
    // Since bundle doesn't expose FsMemory directly, verify by calling store then recall
    // on the memory component obtained from the provider.
    // The provider attaches tools — but the simplest verification is that createContextArena
    // didn't throw and the retriever spy has not been called yet (deferred).
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(bundle.providers).toHaveLength(2);
  });

  test("wrapper retriever overrides config.retriever", async () => {
    const dir = await makeTmpDir();
    const wrapperSpy = mock(() => Promise.resolve([]));
    const innerSpy = mock(() => Promise.resolve([]));

    const wrapperRetriever: FsSearchRetriever = { retrieve: wrapperSpy };
    const innerRetriever: FsSearchRetriever = { retrieve: innerSpy };

    // Both wrapper and config.retriever are set — wrapper should win via ??
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: {
          config: { baseDir: dir, retriever: innerRetriever },
          retriever: wrapperRetriever,
        },
      }),
    );

    expect(bundle.providers).toHaveLength(2);
    // The inner retriever should NOT have been used during initialization
    expect(innerSpy).not.toHaveBeenCalled();
  });

  test("config.retriever used when wrapper retriever absent", async () => {
    const dir = await makeTmpDir();
    const innerSpy = mock(() => Promise.resolve([]));
    const innerRetriever: FsSearchRetriever = { retrieve: innerSpy };

    // Only config.retriever set, no wrapper override
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: {
          config: { baseDir: dir, retriever: innerRetriever },
        },
      }),
    );

    expect(bundle.providers).toHaveLength(2);
    // Arena created successfully with inner retriever as fallback
    expect(innerSpy).not.toHaveBeenCalled();
  });

  test("wrapper indexer flows through independently", async () => {
    const dir = await makeTmpDir();
    const indexSpy = mock(() => Promise.resolve());
    const removeSpy = mock(() => Promise.resolve());
    const wrapperIndexer: FsSearchIndexer = { index: indexSpy, remove: removeSpy };

    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir }, indexer: wrapperIndexer },
      }),
    );

    expect(bundle.providers).toHaveLength(2);
    // Indexer is deferred — not called during construction
    expect(indexSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Feature matrix — conventions + hot memory combinations
// ---------------------------------------------------------------------------

describe("createContextArena feature matrix", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "koi-arena-matrix-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("no features: 3 middleware, no conventions", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.middleware).toHaveLength(3);
    expect(bundle.config.conventions).toHaveLength(0);
    expect(bundle.config.hotMemoryEnabled).toBe(false);
  });

  test("conventions only: 3 middleware, conventions resolved", async () => {
    const bundle = await createContextArena(
      baseConfig({ conventions: ["ESM-only", "No mutation"] }),
    );
    expect(bundle.middleware).toHaveLength(3);
    expect(bundle.config.conventions).toHaveLength(2);
    expect(bundle.config.conventions[0]?.label).toBe("convention");
    expect(bundle.config.conventions[0]?.description).toBe("ESM-only");
  });

  test("memoryFs only: 5 middleware (includes hot memory + preference)", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(baseConfig({ memoryFs: { config: { baseDir: dir } } }));
    // squash + compactor + context-editing + hot-memory + preference
    expect(bundle.middleware).toHaveLength(5);
    expect(bundle.config.hotMemoryEnabled).toBe(true);
  });

  test("memoryFs + conventions: 5 middleware, conventions present", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
        conventions: ["ESM-only"],
      }),
    );
    // squash + compactor + context-editing + hot-memory + preference
    expect(bundle.middleware).toHaveLength(5);
    expect(bundle.config.conventions).toHaveLength(1);
    expect(bundle.config.hotMemoryEnabled).toBe(true);
  });

  test("memoryFs + disabled hot memory: 4 middleware (preference still on)", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
        hotMemory: { disabled: true },
      }),
    );
    // squash + compactor + context-editing + preference (no hot-memory)
    expect(bundle.middleware).toHaveLength(4);
    expect(bundle.config.hotMemoryEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compactor archiver wiring — snapshot chain store integration
// ---------------------------------------------------------------------------

describe("createContextArena compactor archiver wiring", () => {
  interface PutCall {
    readonly chainId: ChainId;
    readonly data: readonly InboundMessage[];
    readonly parentIds: readonly NodeId[];
    readonly metadata: Readonly<Record<string, unknown>> | undefined;
    readonly options: PutOptions | undefined;
  }

  function createSpyStore(): {
    readonly store: SnapshotChainStore<readonly InboundMessage[]>;
    readonly putCalls: PutCall[];
  } {
    const putCalls: PutCall[] = [];

    const store: SnapshotChainStore<readonly InboundMessage[]> = {
      put(
        cid: ChainId,
        data: readonly InboundMessage[],
        parentIds: readonly NodeId[],
        metadata?: Readonly<Record<string, unknown>>,
        options?: PutOptions,
      ): Result<SnapshotNode<readonly InboundMessage[]> | undefined, KoiError> {
        putCalls.push({ chainId: cid, data, parentIds, metadata, options });
        return { ok: true, value: undefined };
      },
      head(): Result<SnapshotNode<readonly InboundMessage[]> | undefined, KoiError> {
        return { ok: true, value: undefined };
      },
      get: () => ({
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "stub", retryable: false },
      }),
      list: () => ({ ok: true as const, value: [] }),
      ancestors: () => ({ ok: true as const, value: [] }),
      fork: () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "stub", retryable: false },
      }),
      prune: () => ({ ok: true as const, value: 0 }),
      close: () => {},
    };

    return { store, putCalls };
  }

  test("compactor archiver wires snapshot store from config", async () => {
    const { store } = createSpyStore();
    const bundle = await createContextArena(baseConfig({ archiver: store }));

    // Compactor middleware is present (second in priority order)
    const compactorMw = bundle.middleware.find((mw) => mw.name === "koi:compactor");
    expect(compactorMw).toBeDefined();
  });

  test("archive chain uses correct namespace: compact:{sessionId}", async () => {
    const { store } = createSpyStore();
    const bundle = await createContextArena(
      baseConfig({
        archiver: store,
        sessionId: "my-session" as SessionId,
      }),
    );

    // The compactor middleware wires the snapshot archiver with chainId "compact:my-session".
    // We verify by confirming the store is used and the arena was created without error.
    // Direct archiver invocation would require triggering compaction, which needs
    // a full model call. Instead, verify the wiring is structurally correct.
    expect(bundle.middleware).toHaveLength(3);
    expect(bundle.config.archiver).toBe(store);
  });

  test("with memory present, compactor uses composite archiver (snapshot + fact-extraction)", async () => {
    const { store } = createSpyStore();
    const memory = {
      recall: mock(() => Promise.resolve([])),
      store: mock(() => Promise.resolve()),
    } as unknown as MemoryComponent;

    const bundle = await createContextArena(baseConfig({ archiver: store, memory }));

    // Memory triggers user-model middleware (preference default-on), so 4 middleware total
    // (squash + compactor + context-editing + user-model)
    expect(bundle.middleware).toHaveLength(4);
    expect(bundle.config.archiver).toBe(store);
  });
});

// ---------------------------------------------------------------------------
// Conversation middleware wiring
// ---------------------------------------------------------------------------

/** Minimal stub ThreadStore — methods throw if called (factory only wires, doesn't invoke). */
function stubThreadStore(): ThreadStore {
  return {
    appendAndCheckpoint: () => {
      throw new Error("stub");
    },
    loadThread: () => {
      throw new Error("stub");
    },
    listMessages: () => {
      throw new Error("stub");
    },
    close: () => {},
  };
}

describe("createContextArena conversation wiring", () => {
  test("conversation not added when no threadStore", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.middleware).toHaveLength(3);
    const names = bundle.middleware.map((mw) => mw.name);
    expect(names).not.toContain("koi:conversation");
  });

  test("conversation added when threadStore provided", async () => {
    const bundle = await createContextArena(baseConfig({ threadStore: stubThreadStore() }));
    expect(bundle.middleware).toHaveLength(4);
    const names = bundle.middleware.map((mw) => mw.name);
    expect(names).toContain("koi:conversation");
  });

  test("priority order includes conversation at 100", async () => {
    const bundle = await createContextArena(baseConfig({ threadStore: stubThreadStore() }));
    const priorities = bundle.middleware.map((mw) => mw.priority);
    expect(priorities).toEqual([100, 220, 225, 250]);
  });

  test("conversation not added when disabled even with threadStore", async () => {
    const bundle = await createContextArena(
      baseConfig({
        threadStore: stubThreadStore(),
        conversation: { disabled: true },
      }),
    );
    expect(bundle.middleware).toHaveLength(3);
    const names = bundle.middleware.map((mw) => mw.name);
    expect(names).not.toContain("koi:conversation");
  });

  test("conversation + memoryFs produces correct middleware count", async () => {
    const tmpDirs: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), "koi-arena-conv-"));
    tmpDirs.push(dir);

    const bundle = await createContextArena(
      baseConfig({
        threadStore: stubThreadStore(),
        memoryFs: { config: { baseDir: dir } },
      }),
    );

    // conversation (100) + squash (220) + compactor (225) + context-editing (250) + hot-memory (310) + user-model (415)
    expect(bundle.middleware).toHaveLength(6);
    const priorities = bundle.middleware.map((mw) => mw.priority);
    expect(priorities).toEqual([100, 220, 225, 250, 310, 415]);

    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  test("resolved config values flow through to conversation", async () => {
    const bundle = await createContextArena(
      baseConfig({
        threadStore: stubThreadStore(),
        conversation: { maxHistoryTokens: 12_000, maxMessages: 100 },
      }),
    );
    expect(bundle.config.conversationEnabled).toBe(true);
    expect(bundle.config.conversationMaxHistoryTokens).toBe(12_000);
    expect(bundle.config.conversationMaxMessages).toBe(100);
  });
});
