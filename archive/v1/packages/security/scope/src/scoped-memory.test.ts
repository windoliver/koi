import { describe, expect, test } from "bun:test";
import type {
  AttachResult,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
} from "@koi/core";
import { COMPONENT_PRIORITY, isAttachResult, MEMORY } from "@koi/core";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

import { createScopedMemory, createScopedMemoryProvider } from "./scoped-memory.js";

// ---------------------------------------------------------------------------
// Mock memory component
// ---------------------------------------------------------------------------

interface MockMemory extends MemoryComponent {
  readonly stored: readonly { content: string; options?: MemoryStoreOptions }[];
  readonly recalled: readonly { query: string; options?: MemoryRecallOptions }[];
}

function createMockMemory(results: readonly MemoryResult[] = []): MockMemory {
  const stored: { content: string; options?: MemoryStoreOptions }[] = [];
  const recalled: { query: string; options?: MemoryRecallOptions }[] = [];

  return {
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      stored.push(options !== undefined ? { content, options } : { content });
    },
    async recall(query: string, options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      recalled.push(options !== undefined ? { query, options } : { query });
      return results;
    },
    stored,
    recalled,
  };
}

// ---------------------------------------------------------------------------
// createScopedMemory
// ---------------------------------------------------------------------------

describe("createScopedMemory", () => {
  test("store passes namespace to backend", async () => {
    const backend = createMockMemory();
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    await scoped.store("hello world");
    expect(backend.stored).toHaveLength(1);
    const first = backend.stored[0];
    expect(first).toBeDefined();
    expect(first?.options?.namespace).toBe("agent-a");
  });

  test("store preserves existing options", async () => {
    const backend = createMockMemory();
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    await scoped.store("tagged", { tags: ["important"] });
    expect(backend.stored).toHaveLength(1);
    const first = backend.stored[0];
    expect(first).toBeDefined();
    expect(first?.options?.namespace).toBe("agent-a");
    expect(first?.options?.tags).toEqual(["important"]);
  });

  test("recall passes namespace to backend", async () => {
    const backend = createMockMemory();
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    await scoped.recall("search query");
    expect(backend.recalled).toHaveLength(1);
    const first = backend.recalled[0];
    expect(first).toBeDefined();
    expect(first?.options?.namespace).toBe("agent-a");
  });

  test("recall returns results when backend supports namespace natively", async () => {
    const results: readonly MemoryResult[] = [
      { content: "match", metadata: { namespace: "agent-a" } },
    ];
    const backend = createMockMemory(results);
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    const found = await scoped.recall("query");
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe("match");
  });

  test("recall filters results by namespace metadata", async () => {
    const results: readonly MemoryResult[] = [
      { content: "match", metadata: { namespace: "agent-a" } },
      { content: "other", metadata: { namespace: "agent-b" } },
    ];
    const backend = createMockMemory(results);
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    const found = await scoped.recall("query");
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe("match");
  });

  test("recall rejects untagged records when backend ignores namespace", async () => {
    // Backend returns results without namespace metadata — should be rejected
    // to prevent leaking untagged records across scope boundaries
    const results: readonly MemoryResult[] = [
      { content: "no-meta" },
      { content: "with-meta", metadata: { namespace: "agent-b" } },
    ];
    const backend = createMockMemory(results);
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    const found = await scoped.recall("query");
    // Both are filtered out: "no-meta" has no namespace, "with-meta" has wrong namespace
    expect(found).toHaveLength(0);
  });

  test("empty recall returns empty array", async () => {
    const backend = createMockMemory([]);
    const scoped = createScopedMemory(backend, { namespace: "agent-a" });
    const found = await scoped.recall("query");
    expect(found).toHaveLength(0);
  });

  test("namespace isolation: two scoped views don't see each other's data", async () => {
    const allResults: readonly MemoryResult[] = [
      { content: "a-data", metadata: { namespace: "ns-a" } },
      { content: "b-data", metadata: { namespace: "ns-b" } },
    ];
    const backend = createMockMemory(allResults);
    const scopedA = createScopedMemory(backend, { namespace: "ns-a" });
    const scopedB = createScopedMemory(backend, { namespace: "ns-b" });

    const foundA = await scopedA.recall("query");
    expect(foundA).toHaveLength(1);
    expect(foundA[0]?.content).toBe("a-data");

    const foundB = await scopedB.recall("query");
    expect(foundB).toHaveLength(1);
    expect(foundB[0]?.content).toBe("b-data");
  });
});

// ---------------------------------------------------------------------------
// createScopedMemoryProvider
// ---------------------------------------------------------------------------

describe("createScopedMemoryProvider", () => {
  test("attaches scoped memory under MEMORY token", async () => {
    const backend = createMockMemory();
    const provider = createScopedMemoryProvider(backend, { namespace: "agent-a" });
    const agent = {} as Parameters<typeof provider.attach>[0];
    const components = extractMap(await provider.attach(agent));
    expect(components.has(MEMORY as string)).toBe(true);
  });

  test("uses AGENT_FORGED priority", () => {
    const backend = createMockMemory();
    const provider = createScopedMemoryProvider(backend, { namespace: "agent-a" });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });
});
