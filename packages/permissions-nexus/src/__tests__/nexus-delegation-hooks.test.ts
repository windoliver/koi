/**
 * Tests for Nexus delegation hooks.
 *
 * - createNexusOnGrant: async-blocking, fail-closed (throws on batchWrite failure)
 * - createNexusOnRevoke: best-effort (swallows errors, no-ops on missing grant)
 */

import { describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId, KoiError } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import { createNexusOnGrant, createNexusOnRevoke } from "../nexus-delegation-hooks.js";
import type { NexusPermissionBackend } from "../nexus-permission-backend.js";
import { mapGrantToTuples } from "../nexus-permission-backend.js";
import type { RelationshipTuple } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockGrant(overrides?: Partial<DelegationGrant>): DelegationGrant {
  return {
    id: delegationId("grant-1"),
    issuerId: agentId("agent-1"),
    delegateeId: agentId("agent-2"),
    scope: {
      permissions: { allow: ["read_file", "write_file"] },
    },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    proof: { kind: "hmac-sha256", digest: "test-digest" },
    ...overrides,
  };
}

function createMockBackend(opts?: {
  readonly batchWriteResult?: { readonly ok: false; readonly error: KoiError };
}): {
  readonly backend: NexusPermissionBackend;
  readonly writes: Array<{ readonly tuple: RelationshipTuple; readonly operation: string }>;
} {
  const writes: Array<{ readonly tuple: RelationshipTuple; readonly operation: string }> = [];

  const batchWriteResult =
    opts?.batchWriteResult ?? ({ ok: true as const, value: undefined } as const);

  const backend: NexusPermissionBackend = {
    check: async () => ({ effect: "allow" as const }),
    grant: async () => ({ ok: true as const, value: undefined }),
    delete: async () => ({ ok: true as const, value: undefined }),
    batchWrite: async (w) => {
      writes.push(...w);
      return batchWriteResult;
    },
  };

  return { backend, writes };
}

// ---------------------------------------------------------------------------
// createNexusOnGrant
// ---------------------------------------------------------------------------

describe("createNexusOnGrant", () => {
  test("writes tuples to Nexus with operation 'write'", async () => {
    const { backend, writes } = createMockBackend();
    const onGrant = createNexusOnGrant(backend);
    const grant = createMockGrant();

    await onGrant(grant);

    const expectedTuples = mapGrantToTuples(grant);
    expect(writes).toHaveLength(expectedTuples.length);
    for (const write of writes) {
      expect(write.operation).toBe("write");
    }
    const writtenTuples = writes.map((w) => w.tuple);
    expect(writtenTuples).toEqual([...expectedTuples]);
  });

  test("throws when batchWrite fails so grant can be rolled back", async () => {
    const failError: KoiError = {
      code: "EXTERNAL" as const,
      message: "Nexus unavailable",
      retryable: true,
    };
    const { backend } = createMockBackend({
      batchWriteResult: { ok: false as const, error: failError },
    });
    const onGrant = createNexusOnGrant(backend);
    const grant = createMockGrant();

    await expect(onGrant(grant)).rejects.toThrow();
  });

  test("does not call batchWrite when grant has no allowed permissions", async () => {
    const { backend, writes } = createMockBackend();
    const onGrant = createNexusOnGrant(backend);
    const grant = createMockGrant({
      scope: { permissions: { allow: [] } },
    });

    await onGrant(grant);

    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createNexusOnRevoke
// ---------------------------------------------------------------------------

describe("createNexusOnRevoke", () => {
  test("deletes tuples from Nexus with operation 'delete'", async () => {
    const { backend, writes } = createMockBackend();
    const grant = createMockGrant();
    const getGrant = (_id: DelegationId) => grant;
    const onRevoke = createNexusOnRevoke(backend, getGrant);

    await onRevoke(grant.id, false);

    const expectedTuples = mapGrantToTuples(grant);
    expect(writes).toHaveLength(expectedTuples.length);
    for (const write of writes) {
      expect(write.operation).toBe("delete");
    }
    const writtenTuples = writes.map((w) => w.tuple);
    expect(writtenTuples).toEqual([...expectedTuples]);
  });

  test("is best-effort — swallows batchWrite errors without throwing", async () => {
    const failError: KoiError = {
      code: "EXTERNAL" as const,
      message: "Nexus unavailable",
      retryable: true,
    };
    const { backend } = createMockBackend({
      batchWriteResult: { ok: false as const, error: failError },
    });
    const grant = createMockGrant();
    const getGrant = (_id: DelegationId) => grant;
    const onRevoke = createNexusOnRevoke(backend, getGrant);

    // Must not throw — revocation is the safety operation
    await expect(onRevoke(grant.id, false)).resolves.toBeUndefined();
  });

  test("does nothing when grant is not found", async () => {
    const { backend, writes } = createMockBackend();
    const getGrant = (_id: DelegationId): DelegationGrant | undefined => undefined;
    const onRevoke = createNexusOnRevoke(backend, getGrant);

    await onRevoke(delegationId("nonexistent-grant"), false);

    expect(writes).toHaveLength(0);
  });
});
