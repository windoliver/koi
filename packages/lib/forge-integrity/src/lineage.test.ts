import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeStore, KoiError, Result } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { makeTool, recomputeFixtureId } from "./__tests__/fixtures.js";
import { createBrickVerifier } from "./integrity.js";
import {
  findDuplicateById,
  getParentBrickId,
  isDerivedFrom,
  MAX_LINEAGE_DEPTH,
} from "./lineage.js";

const verify = createBrickVerifier({ "koi/forge": recomputeFixtureId });

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

  test("findDuplicateById detects verified content-equivalent brick within one producer", () => {
    const a = makeTool({ implementation: "code" });
    const b = makeTool({ implementation: "code" });
    expect(findDuplicateById([a], b.id, "koi/forge", verify)?.id).toBe(a.id);
  });

  test("findDuplicateById returns undefined when no match", () => {
    const a = makeTool({ implementation: "code" });
    const novel = computeBrickId("tool", "different");
    expect(findDuplicateById([a], novel, "koi/forge", verify)).toBeUndefined();
  });

  test("findDuplicateById rejects a poisoned store entry that fails verification", () => {
    const real = makeTool({ implementation: "code" });
    // A poisoned entry shares the candidate id but tampered content cannot
    // recompute to the same canonical id. The verifier must catch it.
    const poisoned: BrickArtifact = { ...real, implementation: "// poisoned" } as BrickArtifact;
    expect(findDuplicateById([poisoned], real.id, "koi/forge", verify)).toBeUndefined();
    // The real one verifies and is returned.
    expect(findDuplicateById([poisoned, real], real.id, "koi/forge", verify)?.id).toBe(real.id);
  });

  test("isDerivedFrom rejects forged direct-parent edge by verifying the named ancestor", async () => {
    // Attacker constructs a child whose provenance.parentBrickId points at a
    // trusted ancestor id without ever being derived from it. Without
    // verification the bypass succeeds; with verification it must not.
    const trustedAncestor = makeTool({ implementation: "trusted" });
    const forgedChild = makeTool({ implementation: "evil", parentBrickId: trustedAncestor.id });
    // Stash a tampered version under the trusted id so the load returns
    // matching id but content fails recompute.
    const tampered = { ...trustedAncestor, implementation: "// tampered" } as BrickArtifact;
    const store: ForgeStore = {
      save: () => Promise.resolve({ ok: true, value: undefined }),
      load: () => Promise.resolve({ ok: true, value: tampered } as Result<BrickArtifact, KoiError>),
      search: () => notImplemented(),
      remove: () => notImplemented(),
      update: () => notImplemented(),
      exists: () => Promise.resolve({ ok: true, value: false }),
    };
    const result = await isDerivedFrom(forgedChild, trustedAncestor.id, store, {
      verify,
      producerBuilderId: "koi/forge",
    });
    expect(result.kind).toBe("integrity_failed");
  });

  test("isDerivedFrom rejects non-canonical ancestor argument as malformed", async () => {
    const root = makeTool();
    const child = makeTool({ implementation: "v2", parentBrickId: root.id });
    const result = await isDerivedFrom(
      child,
      "not-a-brick-id" as unknown as BrickId,
      fixtureStore([root]),
    );
    expect(result.kind).toBe("malformed");
  });

  test("isDerivedFrom integrity-verifies each loaded ancestor when verify option is supplied", async () => {
    const root = makeTool({ implementation: "v1" });
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const child = makeTool({ implementation: "v3", parentBrickId: mid.id });
    // Stash a tampered version of mid under mid.id so the load returns
    // matching id but the content fails recompute.
    const tamperedMid = { ...mid, implementation: "// tampered" } as BrickArtifact;
    const tamperedStore: ForgeStore = {
      save: () => Promise.resolve({ ok: true, value: undefined }),
      load: (id: BrickId) =>
        Promise.resolve(
          id === root.id
            ? ({ ok: true, value: root } as Result<BrickArtifact, KoiError>)
            : ({ ok: true, value: tamperedMid } as Result<BrickArtifact, KoiError>),
        ),
      search: () => notImplemented(),
      remove: () => notImplemented(),
      update: () => notImplemented(),
      exists: () => Promise.resolve({ ok: true, value: false }),
    };
    const result = await isDerivedFrom(child, root.id, tamperedStore, {
      verify,
      producerBuilderId: "koi/forge",
    });
    expect(result.kind).toBe("integrity_failed");
    if (result.kind === "integrity_failed") expect(result.at).toBe(mid.id);
  });

  test("isDerivedFrom returns malformed when store returns a brick with a different id", async () => {
    const root = makeTool({ implementation: "v1" });
    const mid = makeTool({ implementation: "v2", parentBrickId: root.id });
    const child = makeTool({ implementation: "v3", parentBrickId: mid.id });
    // Cache confusion: load(mid.id) returns root (different id).
    const wrong = makeTool({ implementation: "wrong" });
    const cacheConfusedStore: ForgeStore = {
      save: () => Promise.resolve({ ok: true, value: undefined }),
      load: (_id: BrickId) =>
        Promise.resolve({ ok: true, value: wrong } as Result<BrickArtifact, KoiError>),
      search: () => notImplemented(),
      remove: () => notImplemented(),
      update: () => notImplemented(),
      exists: () => Promise.resolve({ ok: true, value: false }),
    };
    const result = await isDerivedFrom(child, root.id, cacheConfusedStore);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.at).toBe(mid.id);
      expect(result.reason).toContain("expected");
    }
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
