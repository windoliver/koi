import { describe, expect, mock, test } from "bun:test";
import type { MemoryRecord, MemoryRecordId, MemoryRecordInput, ModelHandler } from "@koi/core";
import { runDreamConsolidation } from "./consolidate.js";
import type { DreamConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function createMemory(
  id: string,
  content: string,
  type: "user" | "feedback" | "project" | "reference" = "feedback",
  daysOld: number = 1,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    name: `Memory ${id}`,
    description: `Desc for ${id}`,
    type,
    content,
    filePath: `${id}.md`,
    createdAt: NOW - daysOld * DAY_MS,
    updatedAt: NOW - daysOld * DAY_MS,
  };
}

function createMockModelCall(mergedContent?: {
  name: string;
  description: string;
  type: string;
  content: string;
}): ModelHandler {
  const response = mergedContent !== undefined ? JSON.stringify(mergedContent) : "[]";
  return mock(async () => ({
    content: response,
    model: "test-model",
  }));
}

function createConfig(
  memories: readonly MemoryRecord[],
  modelCall: ModelHandler,
  overrides?: Partial<DreamConfig>,
): DreamConfig {
  const written: MemoryRecordInput[] = [];
  const deleted: MemoryRecordId[] = [];

  return {
    listMemories: async () => memories,
    writeMemory: async (input: MemoryRecordInput) => {
      written.push(input);
    },
    deleteMemory: async (id: MemoryRecordId) => {
      deleted.push(id);
    },
    modelCall,
    now: NOW,
    ...overrides,
    // Expose for assertions
    get _written() {
      return written;
    },
    get _deleted() {
      return deleted;
    },
  } as DreamConfig & {
    readonly _written: MemoryRecordInput[];
    readonly _deleted: MemoryRecordId[];
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDreamConsolidation", () => {
  test("returns zeros for empty memory list", async () => {
    const config = createConfig([], createMockModelCall());
    const result = await runDreamConsolidation(config);

    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  test("leaves singleton memories unchanged", async () => {
    const memories = [
      createMemory("1", "Always validate input at boundaries", "feedback", 5),
      createMemory("2", "Use dependency injection for testing", "reference", 3),
    ];
    const config = createConfig(memories, createMockModelCall());
    const result = await runDreamConsolidation(config);

    expect(result.unchanged).toBe(2);
    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
  });

  test("prunes memories below salience threshold", async () => {
    const memories = [createMemory("old", "Ancient fact about deprecated API", "project", 365)];
    const config = createConfig(memories, createMockModelCall(), {
      pruneThreshold: 0.05,
    });
    const result = await runDreamConsolidation(config);

    expect(result.pruned).toBe(1);
    const cfg = config as unknown as { readonly _deleted: MemoryRecordId[] };
    expect(cfg._deleted).toContain("old" as MemoryRecordId);
  });

  test("merges similar memories via LLM", async () => {
    const memories = [
      createMemory("a", "Always check for null before accessing properties", "feedback", 2),
      createMemory("b", "Always check for null when accessing nested properties", "feedback", 3),
    ];
    const modelCall = createMockModelCall({
      name: "Null safety",
      description: "Always null-check before property access",
      type: "feedback",
      content: "Always check for null before accessing properties, especially nested ones.",
    });
    const config = createConfig(memories, modelCall, {
      mergeThreshold: 0.3, // Low threshold to ensure these match
    });
    const result = await runDreamConsolidation(config);

    expect(result.merged).toBe(1);
    const cfg = config as unknown as {
      readonly _written: MemoryRecordInput[];
      readonly _deleted: MemoryRecordId[];
    };
    expect(cfg._written).toHaveLength(1);
    expect(cfg._written[0]?.content).toContain("null");
    // Both originals should be deleted
    expect(cfg._deleted).toContain("a" as MemoryRecordId);
    expect(cfg._deleted).toContain("b" as MemoryRecordId);
  });

  test("handles LLM failure gracefully — leaves cluster unchanged", async () => {
    const memories = [
      createMemory("x", "validate input at boundary layer", "feedback", 2),
      createMemory("y", "validate input at the boundary", "feedback", 3),
    ];
    const failingModel = mock(async () => {
      throw new Error("model unavailable");
    }) as unknown as ModelHandler;
    const config = createConfig(memories, failingModel, {
      mergeThreshold: 0.3,
    });
    const result = await runDreamConsolidation(config);

    // Should not throw, cluster left unchanged
    expect(result.merged).toBe(0);
    expect(result.unchanged).toBe(2);
  });

  test("handles malformed LLM response — leaves cluster unchanged", async () => {
    const memories = [
      createMemory("p", "use dependency injection", "reference", 2),
      createMemory("q", "use dependency injection for testing", "reference", 3),
    ];
    // Override to return invalid response
    const config = createConfig(
      memories,
      mock(async () => ({
        content: "I can't merge these",
        model: "test",
      })),
      { mergeThreshold: 0.3 },
    );
    const result = await runDreamConsolidation(config);

    expect(result.merged).toBe(0);
    expect(result.unchanged).toBe(2);
  });

  test("handles delete failure gracefully during prune", async () => {
    const memories = [createMemory("fail-delete", "ancient deprecated thing", "project", 365)];
    const config: DreamConfig = {
      listMemories: async () => memories,
      writeMemory: async () => {},
      deleteMemory: async () => {
        throw new Error("permission denied");
      },
      modelCall: createMockModelCall(),
      now: NOW,
      pruneThreshold: 0.05,
    };
    const result = await runDreamConsolidation(config);

    // Should not throw, prune count is 0 (failed)
    expect(result.pruned).toBe(0);
  });

  test("uses injected similarity function", async () => {
    const customSimilarity = mock(() => 0.0); // Never similar
    const memories = [
      createMemory("1", "same thing", "feedback", 2),
      createMemory("2", "same thing", "feedback", 3),
    ];
    const config = createConfig(memories, createMockModelCall(), {
      similarity: customSimilarity,
    });
    const result = await runDreamConsolidation(config);

    expect(customSimilarity).toHaveBeenCalled();
    // All singletons since similarity always returns 0
    expect(result.unchanged).toBe(2);
    expect(result.merged).toBe(0);
  });

  test("never merges user and non-user memories even when content is similar", async () => {
    const memories = [
      createMemory("u1", "always validate input at boundaries", "user", 2),
      createMemory("f1", "always validate input at boundaries", "feedback", 2),
    ];
    const modelCall = createMockModelCall({
      name: "Merged",
      description: "Merged",
      type: "feedback",
      content: "Merged content",
    });
    const config = createConfig(memories, modelCall, {
      mergeThreshold: 0.3,
    });
    const result = await runDreamConsolidation(config);

    // Both should remain unchanged — different types prevent clustering
    expect(result.merged).toBe(0);
    expect(result.unchanged).toBe(2);
    // Model should not even be called since no multi-member clusters
    expect(modelCall).not.toHaveBeenCalled();
  });
});
