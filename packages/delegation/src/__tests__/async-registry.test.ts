/**
 * Tests for async RevocationRegistry code paths.
 *
 * Verifies that verifyGrant and revokeGrant correctly await
 * async registry operations (the bug fix from Phase 1).
 */

import { describe, expect, test } from "bun:test";
import type { DelegationId, DelegationScope } from "@koi/core";
import { createGrantIndex } from "../registry.js";
import { revokeGrant } from "../revoke.js";
import { signGrant } from "../sign.js";
import { createAsyncRevocationRegistry } from "../test-helpers.js";
import { verifyGrant } from "../verify.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeValidGrant(id?: string): {
  readonly id: DelegationId;
  readonly issuerId: string;
  readonly delegateeId: string;
  readonly scope: DelegationScope;
  readonly chainDepth: number;
  readonly maxChainDepth: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly signature: string;
} {
  const unsigned = {
    id: (id ?? crypto.randomUUID()) as DelegationId,
    issuerId: "agent-1",
    delegateeId: "agent-2",
    scope: { permissions: { allow: ["read_file"] } } as DelegationScope,
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
  };
  const signature = signGrant(unsigned, SECRET);
  return { ...unsigned, signature };
}

describe("async RevocationRegistry", () => {
  test("verifyGrant correctly awaits async isRevoked", async () => {
    const registry = createAsyncRevocationRegistry();
    const grant = makeValidGrant();

    // Not revoked → should pass
    const okResult = await verifyGrant(grant, "read_file", registry, SECRET);
    expect(okResult.ok).toBe(true);

    // Revoke via async registry
    await registry.revoke(grant.id, false);

    // Now should fail with "revoked"
    const revokedResult = await verifyGrant(grant, "read_file", registry, SECRET);
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) {
      expect(revokedResult.reason).toBe("revoked");
    }
  });

  test("revokeGrant correctly awaits async revoke", async () => {
    const registry = createAsyncRevocationRegistry();
    const index = createGrantIndex();
    const grant = makeValidGrant();

    const revoked = await revokeGrant(grant.id, registry, index, false);
    expect(revoked).toEqual([grant.id]);

    // Verify it's in the registry
    const isRevoked = await registry.isRevoked(grant.id);
    expect(isRevoked).toBe(true);
  });

  test("revokeGrant cascade works with async registry", async () => {
    const registry = createAsyncRevocationRegistry();
    const index = createGrantIndex();

    const parent = makeValidGrant("parent-1");
    const child = { ...makeValidGrant("child-1"), parentId: parent.id, chainDepth: 1 };

    index.addGrant(parent);
    index.addGrant(child);

    const revoked = await revokeGrant(parent.id, registry, index, true);
    expect(revoked).toHaveLength(2);

    expect(await registry.isRevoked(parent.id)).toBe(true);
    expect(await registry.isRevoked(child.id)).toBe(true);
  });

  test("middleware works correctly with async registry", async () => {
    const registry = createAsyncRevocationRegistry();
    const grant = makeValidGrant();

    // Verify passes when not revoked
    const okResult = await verifyGrant(grant, "read_file", registry, SECRET);
    expect(okResult.ok).toBe(true);

    // Revoke and verify fails
    await registry.revoke(grant.id, false);
    const failResult = await verifyGrant(grant, "read_file", registry, SECRET);
    expect(failResult.ok).toBe(false);
  });
});
