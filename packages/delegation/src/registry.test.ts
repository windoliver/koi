import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId } from "@koi/core";
import { createGrantIndex, createInMemoryRegistry } from "./registry.js";

describe("createInMemoryRegistry", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  test("isRevoked returns false for unknown ID", () => {
    const registry = createInMemoryRegistry();
    dispose = registry.dispose;

    expect(registry.isRevoked("unknown" as DelegationId)).toBe(false);
  });

  test("revoke marks an ID as revoked", () => {
    const registry = createInMemoryRegistry();
    dispose = registry.dispose;
    const id = "grant-1" as DelegationId;

    registry.revoke(id, false);
    expect(registry.isRevoked(id)).toBe(true);
  });

  test("revokedIds returns all revoked IDs", () => {
    const registry = createInMemoryRegistry();
    dispose = registry.dispose;
    const id1 = "grant-1" as DelegationId;
    const id2 = "grant-2" as DelegationId;

    registry.revoke(id1, false);
    registry.revoke(id2, false);

    const ids = registry.revokedIds();
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);
    expect(ids.size).toBe(2);
  });

  test("respects maxEntries by evicting oldest entries", () => {
    const registry = createInMemoryRegistry({
      maxEntries: 3,
      cleanupIntervalMs: 60_000, // won't trigger during test
    });
    dispose = registry.dispose;

    registry.revoke("a" as DelegationId, false);
    registry.revoke("b" as DelegationId, false);
    registry.revoke("c" as DelegationId, false);
    registry.revoke("d" as DelegationId, false);

    // Oldest entry "a" should be evicted
    expect(registry.revokedIds().size).toBe(3);
    expect(registry.isRevoked("a" as DelegationId)).toBe(false);
    expect(registry.isRevoked("d" as DelegationId)).toBe(true);
  });

  test("dispose stops cleanup interval", () => {
    const registry = createInMemoryRegistry({
      cleanupIntervalMs: 100,
    });
    // Should not throw
    registry.dispose();
  });
});

describe("createGrantIndex", () => {
  function makeGrant(id: DelegationId, parentId?: DelegationId): DelegationGrant {
    const base = {
      id,
      issuerId: "a1",
      delegateeId: "a2",
      scope: { permissions: { allow: ["read_file"] } },
      chainDepth: parentId !== undefined ? 1 : 0,
      maxChainDepth: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: "test",
    };
    return parentId !== undefined ? { ...base, parentId } : base;
  }

  test("childrenOf returns empty for root with no children", () => {
    const index = createGrantIndex();
    const root = makeGrant("root" as DelegationId);
    index.addGrant(root);

    expect(index.childrenOf("root" as DelegationId)).toEqual([]);
  });

  test("childrenOf returns direct children", () => {
    const index = createGrantIndex();
    const root = makeGrant("root" as DelegationId);
    const child1 = makeGrant("c1" as DelegationId, "root" as DelegationId);
    const child2 = makeGrant("c2" as DelegationId, "root" as DelegationId);

    index.addGrant(root);
    index.addGrant(child1);
    index.addGrant(child2);

    const children = index.childrenOf("root" as DelegationId);
    expect(children).toHaveLength(2);
    expect(children).toContain("c1" as DelegationId);
    expect(children).toContain("c2" as DelegationId);
  });

  test("removeGrant removes from parent's children", () => {
    const index = createGrantIndex();
    const root = makeGrant("root" as DelegationId);
    const child = makeGrant("c1" as DelegationId, "root" as DelegationId);

    index.addGrant(root);
    index.addGrant(child);

    expect(index.childrenOf("root" as DelegationId)).toHaveLength(1);

    index.removeGrant(child);

    expect(index.childrenOf("root" as DelegationId)).toHaveLength(0);
  });

  test("addGrant with no parentId does not create child entries", () => {
    const index = createGrantIndex();
    const root = makeGrant("root" as DelegationId);
    index.addGrant(root);

    // Root should not appear as a child of anything
    expect(index.childrenOf("root" as DelegationId)).toEqual([]);
  });
});
