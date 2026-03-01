/**
 * Memory wiring tests for createContextArena.
 *
 * Verifies that effectiveMemory (config.memory ?? fsMemory.component)
 * flows correctly to squash and compactor, and that FsMemory is created
 * once and shared across all consumers.
 *
 * Uses mock.module() to intercept L2 dependencies — separate file from
 * arena-factory.test.ts because mock.module() must precede imports.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MemoryComponent, SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
import type { FsMemory } from "@koi/memory-fs";

// ---------------------------------------------------------------------------
// Capture spies — track what each factory receives
// ---------------------------------------------------------------------------

const squashMemoryCapture: { value: MemoryComponent | undefined } = { value: undefined };
const compactorMemoryCapture: { value: MemoryComponent | undefined } = { value: undefined };
const fsMemoryCreateCapture: { callCount: number } = { callCount: 0 };
const memoryProviderCapture: { value: FsMemory | undefined } = { value: undefined };

const stubFsComponent: MemoryComponent = {
  store: mock(() => Promise.resolve({ ok: true, value: undefined } as const)),
  recall: mock(() => Promise.resolve({ ok: true, value: { facts: [], summary: undefined } })),
  search: mock(() => Promise.resolve({ ok: true, value: [] })),
} as unknown as MemoryComponent;

const stubFsMemory: FsMemory = {
  component: stubFsComponent,
  rebuildSummaries: mock(() => Promise.resolve()),
  getTierDistribution: mock(() => Promise.resolve({ hot: 0, warm: 0, cold: 0, total: 0 })),
  listEntities: mock(() => Promise.resolve([])),
  close: mock(() => Promise.resolve()),
} as unknown as FsMemory;

// ---------------------------------------------------------------------------
// Mock L2 dependencies
// ---------------------------------------------------------------------------

const noopCapability = () => ({ label: "stub", description: "stub" });
const squashMiddlewareStub = {
  priority: 220,
  name: "squash",
  describeCapabilities: noopCapability,
};
const squashProviderStub = { name: "squash-provider", attach: mock(() => {}) };

mock.module("@koi/tool-squash", () => ({
  createSquashProvider: mock((config: { readonly memory?: MemoryComponent | undefined }) => {
    squashMemoryCapture.value = config.memory;
    return { middleware: squashMiddlewareStub, provider: squashProviderStub };
  }),
}));

mock.module("@koi/middleware-compactor", () => ({
  createCompactorMiddleware: mock((config: { readonly memory?: MemoryComponent | undefined }) => {
    compactorMemoryCapture.value = config.memory;
    return { priority: 225, name: "compactor", describeCapabilities: noopCapability };
  }),
}));

mock.module("@koi/middleware-context-editing", () => ({
  createContextEditingMiddleware: mock(() => ({
    priority: 250,
    name: "context-editing",
    describeCapabilities: noopCapability,
  })),
}));

mock.module("@koi/context", () => ({
  createContextHydrator: mock(() => ({ priority: 300 })),
}));

mock.module("@koi/memory-fs", () => ({
  createFsMemory: mock(() => {
    fsMemoryCreateCapture.callCount += 1;
    return Promise.resolve(stubFsMemory);
  }),
  createMemoryProvider: mock((config: { readonly memory: FsMemory }) => {
    memoryProviderCapture.value = config.memory;
    return { name: "memory-provider", attach: mock(() => {}) };
  }),
}));

// Import after mocks are set up
const { createContextArena } = await import("./arena-factory.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createContextArena memory wiring", () => {
  beforeEach(() => {
    squashMemoryCapture.value = undefined;
    compactorMemoryCapture.value = undefined;
    fsMemoryCreateCapture.callCount = 0;
    memoryProviderCapture.value = undefined;
  });

  test("passes config.memory to squash and compactor when provided", async () => {
    const explicitMemory = {
      store: mock(() => Promise.resolve({ ok: true, value: undefined } as const)),
      recall: mock(() => Promise.resolve({ ok: true, value: { facts: [], summary: undefined } })),
      search: mock(() => Promise.resolve({ ok: true, value: [] })),
    } as unknown as MemoryComponent;

    await createContextArena({
      summarizer: stubSummarizer,
      sessionId: "test-session" as SessionId,
      getMessages: (): readonly InboundMessage[] => [],
      memory: explicitMemory,
    });

    expect(squashMemoryCapture.value).toBe(explicitMemory);
    expect(compactorMemoryCapture.value).toBe(explicitMemory);
  });

  test("passes fsMemory.component to squash and compactor when only memoryFs provided", async () => {
    await createContextArena({
      summarizer: stubSummarizer,
      sessionId: "test-session" as SessionId,
      getMessages: (): readonly InboundMessage[] => [],
      memoryFs: { config: { baseDir: "/tmp/test-memory" } },
    });

    expect(squashMemoryCapture.value).toBe(stubFsComponent);
    expect(compactorMemoryCapture.value).toBe(stubFsComponent);
    // Memory provider receives the full FsMemory object, not just .component
    expect(memoryProviderCapture.value).toBe(stubFsMemory);
  });

  test("config.memory overrides fsMemory.component for fact extraction", async () => {
    const explicitMemory = {
      store: mock(() => Promise.resolve({ ok: true, value: undefined } as const)),
      recall: mock(() => Promise.resolve({ ok: true, value: { facts: [], summary: undefined } })),
      search: mock(() => Promise.resolve({ ok: true, value: [] })),
    } as unknown as MemoryComponent;

    await createContextArena({
      summarizer: stubSummarizer,
      sessionId: "test-session" as SessionId,
      getMessages: (): readonly InboundMessage[] => [],
      memory: explicitMemory,
      memoryFs: { config: { baseDir: "/tmp/test-memory" } },
    });

    // Squash + compactor get explicit memory, not fsMemory.component
    expect(squashMemoryCapture.value).toBe(explicitMemory);
    expect(compactorMemoryCapture.value).toBe(explicitMemory);
    // But fsMemory was still created (for provider tools)
    expect(fsMemoryCreateCapture.callCount).toBe(1);
  });

  test("squash and compactor receive undefined when no memory configured", async () => {
    await createContextArena({
      summarizer: stubSummarizer,
      sessionId: "test-session" as SessionId,
      getMessages: (): readonly InboundMessage[] => [],
    });

    expect(squashMemoryCapture.value).toBeUndefined();
    expect(compactorMemoryCapture.value).toBeUndefined();
  });

  test("createFsMemory is called exactly once when memoryFs is provided", async () => {
    await createContextArena({
      summarizer: stubSummarizer,
      sessionId: "test-session" as SessionId,
      getMessages: (): readonly InboundMessage[] => [],
      memoryFs: { config: { baseDir: "/tmp/test-memory" } },
    });

    expect(fsMemoryCreateCapture.callCount).toBe(1);
  });
});
