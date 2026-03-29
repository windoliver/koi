/**
 * Tests for computeLineage — evolution chain traversal.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeStore, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import { createTestToolArtifact } from "@koi/test-utils";
import { computeLineage } from "./lineage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockStore(bricks: readonly BrickArtifact[]): ForgeStore {
  const map = new Map<string, BrickArtifact>();
  for (const b of bricks) {
    map.set(b.id, b);
  }
  return {
    save: mock(async () => ({ ok: true as const, value: undefined })),
    load: mock(async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const b = map.get(id);
      if (b !== undefined) return { ok: true, value: b };
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `not found: ${id}`, retryable: false },
      };
    }),
    search: mock(async () => ({ ok: true as const, value: [] as readonly BrickArtifact[] })),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async () => ({ ok: true as const, value: undefined })),
    exists: mock(async () => ({ ok: true as const, value: false })),
  };
}

/** Create a brick with optional evolution pointing to a parent. */
function brick(
  id: string,
  parentId?: string,
  evolutionKind: "fix" | "derived" | "captured" = "fix",
): BrickArtifact {
  const provenance = createTestToolArtifact().provenance;
  return createTestToolArtifact({
    id: brickId(id),
    name: `brick-${id}`,
    provenance:
      parentId !== undefined
        ? {
            ...provenance,
            evolution: {
              parentBrickId: brickId(parentId),
              evolutionKind,
            },
          }
        : provenance,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("computeLineage — happy path", () => {
  test("returns single brick when no parent", async () => {
    const root = brick("root");
    const store = mockStore([root]);

    const result = await computeLineage(store, brickId("root"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain).toHaveLength(1);
      expect(result.value.chain[0]?.id).toBe(brickId("root"));
      expect(result.value.partial).toBe(false);
    }
  });

  test("returns chain root-first for A → B → C", async () => {
    const a = brick("a");
    const b = brick("b", "a");
    const c = brick("c", "b");
    const store = mockStore([a, b, c]);

    const result = await computeLineage(store, brickId("c"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain).toHaveLength(3);
      expect(result.value.chain[0]?.id).toBe(brickId("a"));
      expect(result.value.chain[1]?.id).toBe(brickId("b"));
      expect(result.value.chain[2]?.id).toBe(brickId("c"));
      expect(result.value.partial).toBe(false);
    }
  });

  test("preserves evolution metadata in chain entries", async () => {
    const a = brick("a");
    const b = brick("b", "a", "fix");
    const c = brick("c", "b", "derived");
    const store = mockStore([a, b, c]);

    const result = await computeLineage(store, brickId("c"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain[0]?.provenance.evolution).toBeUndefined();
      expect(result.value.chain[1]?.provenance.evolution?.evolutionKind).toBe("fix");
      expect(result.value.chain[2]?.provenance.evolution?.evolutionKind).toBe("derived");
    }
  });
});

// ---------------------------------------------------------------------------
// Missing parent (partial chain)
// ---------------------------------------------------------------------------

describe("computeLineage — missing parent", () => {
  test("returns partial chain when parent not found in store", async () => {
    const b = brick("b", "deleted-parent");
    const store = mockStore([b]);

    const result = await computeLineage(store, brickId("b"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain).toHaveLength(1);
      expect(result.value.chain[0]?.id).toBe(brickId("b"));
      expect(result.value.partial).toBe(true);
    }
  });

  test("returns error when start brick not found", async () => {
    const store = mockStore([]);

    const result = await computeLineage(store, brickId("nonexistent"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("computeLineage — cycle detection", () => {
  test("detects A → B → A cycle and returns partial", async () => {
    const a = brick("a", "b");
    const b = brick("b", "a");
    const store = mockStore([a, b]);

    const result = await computeLineage(store, brickId("a"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should stop at cycle, not infinite loop
      expect(result.value.chain.length).toBeLessThanOrEqual(2);
      expect(result.value.partial).toBe(true);
    }
  });

  test("detects self-referencing brick", async () => {
    const self = brick("self", "self");
    const store = mockStore([self]);

    const result = await computeLineage(store, brickId("self"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain).toHaveLength(1);
      expect(result.value.partial).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Depth limit
// ---------------------------------------------------------------------------

describe("computeLineage — depth limit", () => {
  test("respects maxDepth parameter", async () => {
    // Create chain of 10 bricks
    const bricks: BrickArtifact[] = [];
    for (let i = 0; i < 10; i++) {
      bricks.push(brick(`b${i}`, i > 0 ? `b${i - 1}` : undefined));
    }
    const store = mockStore(bricks);

    // Request with maxDepth=3
    const result = await computeLineage(store, brickId("b9"), 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain).toHaveLength(3);
      expect(result.value.partial).toBe(true);
    }
  });

  test("completes within default depth limit for moderate chains", async () => {
    // Create chain of 20 bricks (well within default 50)
    const bricks: BrickArtifact[] = [];
    for (let i = 0; i < 20; i++) {
      bricks.push(brick(`b${i}`, i > 0 ? `b${i - 1}` : undefined));
    }
    const store = mockStore(bricks);

    const result = await computeLineage(store, brickId("b19"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chain).toHaveLength(20);
      expect(result.value.partial).toBe(false);
      // Verify root-first ordering
      expect(result.value.chain[0]?.id).toBe(brickId("b0"));
      expect(result.value.chain[19]?.id).toBe(brickId("b19"));
    }
  });
});

// ---------------------------------------------------------------------------
// Store errors mid-walk
// ---------------------------------------------------------------------------

describe("computeLineage — store errors", () => {
  test("returns partial chain on store error mid-walk", async () => {
    const a = brick("a");
    const b = brick("b", "a");
    const c = brick("c", "b");
    const store = mockStore([b, c]); // 'a' is missing — store.load will fail

    const result = await computeLineage(store, brickId("c"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should have c and b, but not a (missing)
      expect(result.value.chain).toHaveLength(2);
      expect(result.value.chain[0]?.id).toBe(brickId("b"));
      expect(result.value.chain[1]?.id).toBe(brickId("c"));
      expect(result.value.partial).toBe(true);
    }
  });
});
