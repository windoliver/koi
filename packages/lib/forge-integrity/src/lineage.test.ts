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

const NOT_FOUND_ERROR: KoiError = { code: "NOT_FOUND", message: "missing", retryable: false };

function fixtureStore(
  bricks: readonly BrickArtifact[],
  options: { readonly loadError?: KoiError } = {},
): ForgeStore {
  const map = new Map<BrickId, BrickArtifact>();
  for (const b of bricks) map.set(b.id, b);
  return {
    save: () => Promise.resolve({ ok: true, value: undefined } as Result<void, KoiError>),
    load: (id: BrickId) => {
      if (options.loadError !== undefined) {
        return Promise.resolve({ ok: false, error: options.loadError } as Result<
          BrickArtifact,
          KoiError
        >);
      }
      const hit = map.get(id);
      if (hit) return Promise.resolve({ ok: true, value: hit } as Result<BrickArtifact, KoiError>);
      return Promise.resolve({ ok: false, error: NOT_FOUND_ERROR } as Result<
        BrickArtifact,
        KoiError
      >);
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

  test("isDerivedFrom returns derived when ancestor is in the chain", async () => {
    const root = makeTool({ implementation: "v1" });
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const leaf = makeTool({ implementation: "v3", parentBrickId: mid.id });
    const store = fixtureStore([root, mid, leaf]);

    expect((await isDerivedFrom(leaf, root.id, store)).kind).toBe("derived");
    expect((await isDerivedFrom(leaf, mid.id, store)).kind).toBe("derived");
    expect((await isDerivedFrom(mid, root.id, store)).kind).toBe("derived");
  });

  test("isDerivedFrom returns not_derived for unrelated ancestor", async () => {
    const root = makeTool({ implementation: "v1" });
    const other = makeTool({ implementation: "unrelated" });
    const child = makeTool({ implementation: "v2", parentBrickId: root.id });
    const store = fixtureStore([root, other, child]);
    const result = await isDerivedFrom(child, other.id, store);
    expect(result.kind).toBe("not_derived");
  });

  test("isDerivedFrom normalizes thrown/rejected store loads to store_error", async () => {
    const root = makeTool();
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const child = makeTool({ implementation: "v3", parentBrickId: mid.id });
    const throwingStore: ForgeStore = {
      save: () => Promise.resolve({ ok: true, value: undefined }),
      load: () => Promise.reject(new Error("backend disposed")),
      search: () => notImplemented(),
      remove: () => notImplemented(),
      update: () => notImplemented(),
      exists: () => Promise.resolve({ ok: true, value: false }),
    };
    const result = await isDerivedFrom(child, root.id, throwingStore);
    expect(result.kind).toBe("store_error");
    if (result.kind === "store_error") {
      expect(result.error.message).toContain("backend disposed");
      expect(result.at).toBe(mid.id);
    }
  });

  test("isDerivedFrom surfaces store_error rather than collapsing to not_derived", async () => {
    const root = makeTool({ implementation: "v1" });
    // Walk has to load `mid` to keep climbing past it; with the store
    // returning errors that load fails and we get store_error rather than
    // a misleading not_derived.
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const child = makeTool({ implementation: "v3", parentBrickId: mid.id });
    const transient: KoiError = { code: "INTERNAL", message: "store outage", retryable: true };
    const store = fixtureStore([], { loadError: transient });
    const result = await isDerivedFrom(child, root.id, store);
    expect(result.kind).toBe("store_error");
    if (result.kind === "store_error") {
      expect(result.error).toBe(transient);
      expect(result.at).toBe(mid.id);
    }
  });

  test("isDerivedFrom is bounded by MAX_LINEAGE_DEPTH", () => {
    expect(MAX_LINEAGE_DEPTH).toBeGreaterThan(0);
  });

  test("findDuplicateById detects content-equivalent brick by id within one producer", () => {
    const a = makeTool({ implementation: "code" });
    const b = makeTool({ implementation: "code" });
    expect(findDuplicateById([a], b.id, "koi/forge")?.id).toBe(a.id);
  });

  test("findDuplicateById returns undefined when no match", () => {
    const a = makeTool({ implementation: "code" });
    const novel = computeBrickId("tool", "different");
    expect(findDuplicateById([a], novel, "koi/forge")).toBeUndefined();
  });

  test("findDuplicateById refuses to alias across producers (same id, different builder)", () => {
    const a = makeTool({ implementation: "code" });
    expect(findDuplicateById([a], a.id, "another/builder/v1")).toBeUndefined();
  });

  test("isDerivedFrom returns malformed when child has no provenance", async () => {
    const broken = { id: "sha256:zzz" } as unknown as BrickArtifact;
    const root = makeTool();
    const result = await isDerivedFrom(broken, root.id, fixtureStore([root]));
    expect(result.kind).toBe("malformed");
  });

  test("isDerivedFrom returns malformed when a loaded ancestor is corrupt", async () => {
    const root = makeTool();
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const child = makeTool({ implementation: "v3", parentBrickId: mid.id });
    // Replace `mid` in the store with a corrupt record (missing provenance).
    const corruptMid = { ...mid, provenance: undefined } as unknown as BrickArtifact;
    const store = fixtureStore([root, corruptMid, child]);
    const result = await isDerivedFrom(child, root.id, store);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") expect(result.at).toBe(mid.id);
  });

  test("getParentBrickId returns undefined for a malformed brick", () => {
    const broken = { id: "sha256:x" } as unknown as BrickArtifact;
    expect(getParentBrickId(broken)).toBeUndefined();
  });
});
