import { describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId, RevocationRegistry } from "@koi/core";
import { createGrant } from "./grant.js";
import { createGrantIndex } from "./registry.js";
import { revokeGrant } from "./revoke.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeRegistry(): RevocationRegistry & { readonly _revoked: Set<DelegationId> } {
  const revoked = new Set<DelegationId>();
  return {
    _revoked: revoked,
    isRevoked: (id) => revoked.has(id),
    revoke: (id) => {
      revoked.add(id);
    },
  };
}

function makeGrant(issuerId: string, delegateeId: string): DelegationGrant {
  return createGrant({
    issuerId,
    delegateeId,
    scope: { permissions: { allow: ["read_file"] } },
    maxChainDepth: 5,
    ttlMs: 3600000,
    secret: SECRET,
  });
}

describe("revokeGrant", () => {
  test("revokes a single grant without cascade", () => {
    const grant = makeGrant("a1", "a2");
    const registry = makeRegistry();
    const grants = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const index = createGrantIndex();

    const revoked = revokeGrant(grant.id, registry, grants, index, false);

    expect(revoked).toEqual([grant.id]);
    expect(registry.isRevoked(grant.id)).toBe(true);
  });

  test("cascade revokes parent and all children", () => {
    const parent = makeGrant("a1", "a2");

    // Simulate children by creating grants with parentId
    const child1Id = "child-1" as DelegationId;
    const child2Id = "child-2" as DelegationId;
    const grandchildId = "grandchild-1" as DelegationId;

    const child1: DelegationGrant = {
      ...makeGrant("a2", "a3"),
      id: child1Id,
      parentId: parent.id,
      chainDepth: 1,
    };
    const child2: DelegationGrant = {
      ...makeGrant("a2", "a4"),
      id: child2Id,
      parentId: parent.id,
      chainDepth: 1,
    };
    const grandchild: DelegationGrant = {
      ...makeGrant("a3", "a5"),
      id: grandchildId,
      parentId: child1Id,
      chainDepth: 2,
    };

    const grants = new Map<DelegationId, DelegationGrant>([
      [parent.id, parent],
      [child1Id, child1],
      [child2Id, child2],
      [grandchildId, grandchild],
    ]);

    const index = createGrantIndex();
    index.addGrant(parent);
    index.addGrant(child1);
    index.addGrant(child2);
    index.addGrant(grandchild);

    const registry = makeRegistry();
    const revoked = revokeGrant(parent.id, registry, grants, index, true);

    expect(revoked).toHaveLength(4);
    expect(registry.isRevoked(parent.id)).toBe(true);
    expect(registry.isRevoked(child1Id)).toBe(true);
    expect(registry.isRevoked(child2Id)).toBe(true);
    expect(registry.isRevoked(grandchildId)).toBe(true);
  });

  test("cascade with no children only revokes the target", () => {
    const grant = makeGrant("a1", "a2");
    const registry = makeRegistry();
    const grants = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const index = createGrantIndex();
    index.addGrant(grant);

    const revoked = revokeGrant(grant.id, registry, grants, index, true);

    expect(revoked).toEqual([grant.id]);
  });

  test("revoking already-revoked grant is idempotent", () => {
    const grant = makeGrant("a1", "a2");
    const registry = makeRegistry();
    const grants = new Map<DelegationId, DelegationGrant>([[grant.id, grant]]);
    const index = createGrantIndex();

    revokeGrant(grant.id, registry, grants, index, false);
    const revoked = revokeGrant(grant.id, registry, grants, index, false);

    expect(revoked).toEqual([grant.id]);
    expect(registry.isRevoked(grant.id)).toBe(true);
  });
});
