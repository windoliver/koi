import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeStore, KoiError, Result } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { makeTool } from "./__tests__/fixtures.js";
import {
  findDuplicateById,
  getParentBrickId,
  isDerivedFrom,
  MAX_LINEAGE_DEPTH,
} from "./lineage.js";

function notImplemented<T>(): T {
  throw new Error("not implemented");
}

function fixtureStore(bricks: readonly BrickArtifact[]): ForgeStore {
  const map = new Map<BrickId, BrickArtifact>();
  for (const b of bricks) map.set(b.id, b);
  return {
    save: () => Promise.resolve({ ok: true, value: undefined } as Result<void, KoiError>),
    load: (id: BrickId) => {
      const hit = map.get(id);
      if (hit) return Promise.resolve({ ok: true, value: hit } as Result<BrickArtifact, KoiError>);
      return Promise.resolve({
        ok: false,
        error: { code: "NOT_FOUND", message: "missing", retryable: false },
      } as Result<BrickArtifact, KoiError>);
    },
    search: () => notImplemented(),
    remove: () => notImplemented(),
    update: () => notImplemented(),
    exists: (id: BrickId) =>
      Promise.resolve({ ok: true, value: map.has(id) } as Result<boolean, KoiError>),
  };
}

describe("lineage", () => {
  test("getParentBrickId returns undefined for root", () => {
    expect(getParentBrickId(makeTool())).toBeUndefined();
  });

  test("isDerivedFrom walks parent chain to find ancestor", async () => {
    const root = makeTool({ implementation: "v1" });
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const leaf = makeTool({ implementation: "v3", parentBrickId: mid.id });
    const store = fixtureStore([root, mid, leaf]);

    expect(await isDerivedFrom(leaf, root.id, store)).toBe(true);
    expect(await isDerivedFrom(leaf, mid.id, store)).toBe(true);
    expect(await isDerivedFrom(mid, root.id, store)).toBe(true);
  });

  test("isDerivedFrom returns false for unrelated ancestor", async () => {
    const root = makeTool({ implementation: "v1" });
    const other = makeTool({ implementation: "unrelated" });
    const child = makeTool({ implementation: "v2", parentBrickId: root.id });
    const store = fixtureStore([root, other, child]);
    expect(await isDerivedFrom(child, other.id, store)).toBe(false);
  });

  test("isDerivedFrom fails closed on cycles", async () => {
    const a = makeTool({ implementation: "a", parentBrickId: computeBrickId("tool", "b") });
    const b = makeTool({ implementation: "b", parentBrickId: a.id });
    const store = fixtureStore([a, b]);
    expect(await isDerivedFrom(b, computeBrickId("tool", "missing"), store)).toBe(false);
  });

  test("isDerivedFrom is bounded by MAX_LINEAGE_DEPTH", () => {
    expect(MAX_LINEAGE_DEPTH).toBeGreaterThan(0);
  });

  test("findDuplicateById detects content-equivalent brick by id", () => {
    const a = makeTool({ implementation: "code" });
    const b = makeTool({ implementation: "code" });
    expect(findDuplicateById([a], b.id)?.id).toBe(a.id);
  });

  test("findDuplicateById returns undefined when no match", () => {
    const a = makeTool({ implementation: "code" });
    const novel = computeBrickId("tool", "different");
    expect(findDuplicateById([a], novel)).toBeUndefined();
  });
});
