import { describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId, RevocationRegistry } from "@koi/core";
import { agentId } from "@koi/core";
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
  const result = createGrant({
    issuerId: agentId(issuerId),
    delegateeId: agentId(delegateeId),
    scope: { permissions: { allow: ["read_file"] } },
    maxChainDepth: 5,
    ttlMs: 3600000,
    secret: SECRET,
  });
  if (!result.ok) throw new Error("Failed to create grant");
  return result.value;
}

describe("revokeGrant", () => {
  test("revokes a single grant without cascade", async () => {
    const grant = makeGrant("a1", "a2");
    const registry = makeRegistry();
    const index = createGrantIndex();

    const revoked = await revokeGrant(grant.id, registry, index, false);

    expect(revoked).toEqual([grant.id]);
    expect(registry.isRevoked(grant.id)).toBe(true);
  });

  test("cascade revokes parent and all children", async () => {
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

    const index = createGrantIndex();
    index.addGrant(parent);
    index.addGrant(child1);
    index.addGrant(child2);
    index.addGrant(grandchild);

    const registry = makeRegistry();
    const revoked = await revokeGrant(parent.id, registry, index, true);

    expect(revoked).toHaveLength(4);
    expect(registry.isRevoked(parent.id)).toBe(true);
    expect(registry.isRevoked(child1Id)).toBe(true);
    expect(registry.isRevoked(child2Id)).toBe(true);
    expect(registry.isRevoked(grandchildId)).toBe(true);
  });

  test("cascade with no children only revokes the target", async () => {
    const grant = makeGrant("a1", "a2");
    const registry = makeRegistry();
    const index = createGrantIndex();
    index.addGrant(grant);

    const revoked = await revokeGrant(grant.id, registry, index, true);

    expect(revoked).toEqual([grant.id]);
  });

  test("revoking already-revoked grant is idempotent", async () => {
    const grant = makeGrant("a1", "a2");
    const registry = makeRegistry();
    const index = createGrantIndex();

    await revokeGrant(grant.id, registry, index, false);
    const revoked = await revokeGrant(grant.id, registry, index, false);

    expect(revoked).toEqual([grant.id]);
    expect(registry.isRevoked(grant.id)).toBe(true);
  });
});
