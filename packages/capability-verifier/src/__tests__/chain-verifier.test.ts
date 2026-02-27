/**
 * Chain verifier integration tests.
 *
 * Tests verifyChain() with real delegation chains:
 * - A→B→C cascade revocation (Issue 11)
 * - Chain depth consistency enforcement
 * - Scope attenuation enforcement between parent/child
 * - Expiry propagation (child cannot outlive parent)
 * - Batch vs sequential revocation check paths
 * - reconstructChain() and buildChainMap() helpers
 */

import { describe, expect, test } from "bun:test";
import type { CapabilityId, CapabilityToken, DelegationId, RevocationRegistry } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import {
  buildChainMap,
  getOrCreateEd25519Keypair,
  reconstructChain,
  resetKeypairCache,
  verifyChain,
} from "../chain-verifier.js";

const NOW = 1700000000000;
const FUTURE = NOW + 3600000;
const SESSION_1 = sessionId("session-1");

/** Creates a capability token without proof (proof not needed by verifyChain). */
function makeToken(
  id: string,
  chainDepth: number,
  parentId?: string,
  overrides?: Partial<Omit<CapabilityToken, "proof">>,
): CapabilityToken {
  return {
    id: capabilityId(id),
    issuerId: agentId("agent-issuer"),
    delegateeId: agentId("agent-delegatee"),
    scope: {
      permissions: { allow: ["read_file"] },
      sessionId: SESSION_1,
    },
    chainDepth,
    maxChainDepth: 5,
    createdAt: NOW - 1000,
    expiresAt: FUTURE,
    ...(parentId !== undefined ? { parentId: capabilityId(parentId) } : {}),
    proof: { kind: "hmac-sha256", digest: "a".repeat(64) }, // proof not verified by verifyChain
    ...overrides,
  };
}

/** Creates a RevocationRegistry where none are revoked. */
function makeRegistry(revokedIds: readonly string[] = []): RevocationRegistry {
  const revokedSet = new Set(revokedIds);
  return {
    isRevoked: (id: DelegationId): boolean => revokedSet.has(id),
    revoke: (_id: DelegationId, _cascade: boolean): void => {},
  };
}

/** Registry with isRevokedBatch support. */
function _makeBatchRegistry(revokedIds: readonly string[] = []): RevocationRegistry {
  const revokedSet = new Set(revokedIds);
  return {
    isRevoked: (id: DelegationId): boolean => revokedSet.has(id),
    isRevokedBatch: (ids: readonly DelegationId[]): ReadonlyMap<DelegationId, boolean> => {
      const result = new Map<DelegationId, boolean>();
      for (const id of ids) {
        result.set(id, revokedSet.has(id));
      }
      return result;
    },
    revoke: (_id: DelegationId, _cascade: boolean): void => {},
  };
}

const DEFAULT_CONTEXT = {
  toolId: "read_file",
  now: NOW,
  activeSessionIds: new Set([SESSION_1]),
};

// ─────────────────────────────────────────────────────────────
// Empty chain
// ─────────────────────────────────────────────────────────────

describe("verifyChain — empty chain", () => {
  test("empty chain returns ok: true", async () => {
    const result = await verifyChain([], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Single-token chain
// ─────────────────────────────────────────────────────────────

describe("verifyChain — single token", () => {
  test("single valid token at depth 0 returns ok: true", async () => {
    const root = makeToken("root", 0);
    const result = await verifyChain([root], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });

  test("single revoked token returns revoked", async () => {
    const root = makeToken("root", 0);
    const result = await verifyChain([root], makeRegistry(["root"]), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("single token with wrong depth (depth=1 but position=0) returns chain_depth_exceeded", async () => {
    const root = makeToken("root", 1); // depth says 1 but it's at index 0
    const result = await verifyChain([root], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_depth_exceeded");
  });
});

// ─────────────────────────────────────────────────────────────
// A→B→C cascade revocation integration test (Issue 11)
// ─────────────────────────────────────────────────────────────

describe("verifyChain — A→B→C cascade revocation (Issue 11)", () => {
  const tokenA = makeToken("cap-a", 0);
  const tokenB = makeToken("cap-b", 1, "cap-a");
  const tokenC = makeToken("cap-c", 2, "cap-b");
  const chain = [tokenA, tokenB, tokenC] as const;

  test("full A→B→C chain passes when none are revoked", async () => {
    const result = await verifyChain(chain, makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });

  test("revoking A causes chain to fail with revoked", async () => {
    const result = await verifyChain(chain, makeRegistry(["cap-a"]), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("revoking B causes chain to fail with revoked", async () => {
    const result = await verifyChain(chain, makeRegistry(["cap-b"]), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("revoking C causes chain to fail with revoked", async () => {
    const result = await verifyChain(chain, makeRegistry(["cap-c"]), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("uses batch revocation check when registry supports isRevokedBatch", async () => {
    // batchRegistry tracks whether batch was actually called
    let batchCallCount = 0;
    const trackingRegistry: RevocationRegistry = {
      isRevoked: (_id: DelegationId): boolean => false,
      isRevokedBatch: (ids: readonly DelegationId[]): ReadonlyMap<DelegationId, boolean> => {
        batchCallCount++;
        const map = new Map<DelegationId, boolean>();
        for (const id of ids) {
          map.set(id, false);
        }
        return map;
      },
      revoke: (_id: DelegationId, _cascade: boolean): void => {},
    };
    const result = await verifyChain(chain, trackingRegistry, DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
    expect(batchCallCount).toBe(1); // should use batch, not N individual calls
  });

  test("falls back to sequential isRevoked when batch not available", async () => {
    let isRevokedCallCount = 0;
    const seqRegistry: RevocationRegistry = {
      isRevoked: (_id: DelegationId): boolean => {
        isRevokedCallCount++;
        return false;
      },
      revoke: (_id: DelegationId, _cascade: boolean): void => {},
    };
    const result = await verifyChain(chain, seqRegistry, DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
    expect(isRevokedCallCount).toBe(3); // called once per token
  });
});

// ─────────────────────────────────────────────────────────────
// Chain depth consistency
// ─────────────────────────────────────────────────────────────

describe("verifyChain — chain depth consistency", () => {
  test("depths 0,1,2 in order passes", async () => {
    const chain = [makeToken("a", 0), makeToken("b", 1, "a"), makeToken("c", 2, "b")];
    const result = await verifyChain(chain, makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });

  test("skipped depth (0,2) returns chain_depth_exceeded", async () => {
    const chain = [
      makeToken("a", 0),
      makeToken("c", 2, "a"), // depth 2 at position 1 (expected depth 1)
    ];
    const result = await verifyChain(chain, makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_depth_exceeded");
  });

  test("out-of-order depths (1,0) returns chain_depth_exceeded", async () => {
    const chain = [
      makeToken("a", 1), // depth 1 at position 0 (expected 0)
      makeToken("b", 0, "a"),
    ];
    const result = await verifyChain(chain, makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_depth_exceeded");
  });
});

// ─────────────────────────────────────────────────────────────
// Scope attenuation enforcement
// ─────────────────────────────────────────────────────────────

describe("verifyChain — scope attenuation", () => {
  test("child with subset permissions passes", async () => {
    const parentToken = makeToken("parent", 0, undefined, {
      scope: { permissions: { allow: ["read_file", "write_file"] }, sessionId: SESSION_1 },
    });
    const childToken = makeToken("child", 1, "parent", {
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
    });
    const result = await verifyChain([parentToken, childToken], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });

  test("child with permission not in parent returns scope_exceeded", async () => {
    const parentToken = makeToken("parent", 0, undefined, {
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
    });
    const childToken = makeToken("child", 1, "parent", {
      scope: { permissions: { allow: ["read_file", "execute_command"] }, sessionId: SESSION_1 },
    });
    const result = await verifyChain([parentToken, childToken], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });

  test("child expiresAt > parent expiresAt returns scope_exceeded", async () => {
    const parentToken = makeToken("parent", 0, undefined, {
      expiresAt: FUTURE,
    });
    const childToken = makeToken("child", 1, "parent", {
      expiresAt: FUTURE + 1000, // child outlives parent → scope_exceeded
    });
    const result = await verifyChain([parentToken, childToken], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });

  test("child expiresAt === parent expiresAt passes", async () => {
    const parentToken = makeToken("parent", 0, undefined, { expiresAt: FUTURE });
    const childToken = makeToken("child", 1, "parent", { expiresAt: FUTURE });
    const result = await verifyChain([parentToken, childToken], makeRegistry(), DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// buildChainMap
// ─────────────────────────────────────────────────────────────

describe("buildChainMap", () => {
  test("builds a map from token id to token", () => {
    const t1 = makeToken("cap-1", 0);
    const t2 = makeToken("cap-2", 1, "cap-1");
    const map = buildChainMap([t1, t2]);
    expect(map.get(capabilityId("cap-1"))).toBe(t1);
    expect(map.get(capabilityId("cap-2"))).toBe(t2);
  });

  test("empty array returns empty map", () => {
    const map = buildChainMap([]);
    expect(map.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// reconstructChain
// ─────────────────────────────────────────────────────────────

describe("reconstructChain", () => {
  test("reconstructs 3-deep chain in root-first order", () => {
    const a = makeToken("a", 0);
    const b = makeToken("b", 1, "a");
    const c = makeToken("c", 2, "b");
    const store = buildChainMap([a, b, c]) as ReadonlyMap<CapabilityId, CapabilityToken>;
    const chain = reconstructChain(c, store);
    expect(chain).toBeDefined();
    if (chain !== undefined) {
      expect(chain.length).toBe(3);
      expect(chain[0]?.id).toBe(capabilityId("a"));
      expect(chain[1]?.id).toBe(capabilityId("b"));
      expect(chain[2]?.id).toBe(capabilityId("c"));
    }
  });

  test("root token (no parentId) returns single-element chain", () => {
    const root = makeToken("root", 0);
    const store = buildChainMap([root]) as ReadonlyMap<CapabilityId, CapabilityToken>;
    const chain = reconstructChain(root, store);
    expect(chain).toBeDefined();
    if (chain !== undefined) {
      expect(chain.length).toBe(1);
      expect(chain[0]?.id).toBe(capabilityId("root"));
    }
  });

  test("chain gap (parentId not in store) returns undefined", () => {
    const b = makeToken("b", 1, "a"); // "a" not in store
    const store = buildChainMap([b]) as ReadonlyMap<CapabilityId, CapabilityToken>;
    const chain = reconstructChain(b, store);
    expect(chain).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// getOrCreateEd25519Keypair — lazy generation (Issue 15)
// ─────────────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair", () => {
  test("generates and caches Ed25519 keypair on first call", () => {
    resetKeypairCache(); // ensure fresh state
    const kp1 = getOrCreateEd25519Keypair();
    expect(kp1.publicKey).toBeInstanceOf(Buffer);
    expect(kp1.privateKey).toBeInstanceOf(Buffer);
    // Typical Ed25519 SPKI DER is 44 bytes, PKCS8 is 48 bytes
    expect(kp1.publicKey.length).toBeGreaterThan(0);
    expect(kp1.privateKey.length).toBeGreaterThan(0);
  });

  test("returns the same keypair on subsequent calls (lazy singleton)", () => {
    const kp1 = getOrCreateEd25519Keypair();
    const kp2 = getOrCreateEd25519Keypair();
    expect(kp1).toBe(kp2); // exact same object reference
  });
});

// ─────────────────────────────────────────────────────────────
// Async registry (Promise-returning isRevoked)
// ─────────────────────────────────────────────────────────────

describe("verifyChain — async revocation registry", () => {
  test("handles async isRevoked returning false", async () => {
    const asyncRegistry: RevocationRegistry = {
      isRevoked: async (_id: DelegationId): Promise<boolean> => false,
      revoke: (_id: DelegationId, _cascade: boolean): void => {},
    };
    const root = makeToken("root", 0);
    const result = await verifyChain([root], asyncRegistry, DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });

  test("handles async isRevokedBatch", async () => {
    const asyncBatchRegistry: RevocationRegistry = {
      isRevoked: async (_id: DelegationId): Promise<boolean> => false,
      isRevokedBatch: async (
        ids: readonly DelegationId[],
      ): Promise<ReadonlyMap<DelegationId, boolean>> => {
        const map = new Map<DelegationId, boolean>();
        for (const id of ids) {
          map.set(id, false);
        }
        return map;
      },
      revoke: (_id: DelegationId, _cascade: boolean): void => {},
    };
    const chain = [makeToken("a", 0), makeToken("b", 1, "a")];
    const result = await verifyChain(chain, asyncBatchRegistry, DEFAULT_CONTEXT);
    expect(result.ok).toBe(true);
  });
});
