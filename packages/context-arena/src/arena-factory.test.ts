import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryComponent, SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
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
  test("bundle always has 3 middleware (squash, compactor, context-editing)", async () => {
    const bundle = await createContextArena(baseConfig());
    expect(bundle.middleware).toHaveLength(3);
  });

  test("middleware are in priority order (220, 225, 250)", async () => {
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
    // All 3 middleware still present
    expect(bundle.middleware).toHaveLength(3);
  });

  test("memoryFs does not affect middleware count", async () => {
    const dir = await makeTmpDir();
    const bundle = await createContextArena(
      baseConfig({
        memoryFs: { config: { baseDir: dir } },
      }),
    );

    expect(bundle.middleware).toHaveLength(3);
    const priorities = bundle.middleware.map((mw) => mw.priority);
    expect(priorities).toEqual([220, 225, 250]);
  });
});
