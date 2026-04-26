import { describe, expect, test } from "bun:test";
import type { CapabilityToken } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { createMemoryCapabilityRevocationRegistry } from "./revocation.js";

const mkToken = (id: string, parentId?: string): CapabilityToken => {
  const base = {
    id: capabilityId(id),
    issuerId: agentId("alice"),
    delegateeId: agentId("bob"),
    scope: {
      permissions: { allow: ["*"] },
      sessionId: sessionId("sess-1"),
    },
    chainDepth: parentId !== undefined ? 1 : 0,
    maxChainDepth: 3,
    createdAt: 1000,
    expiresAt: 2000,
    proof: { kind: "hmac-sha256", digest: "x" },
  } satisfies Omit<CapabilityToken, "parentId">;
  return parentId !== undefined ? { ...base, parentId: capabilityId(parentId) } : base;
};

describe("createMemoryCapabilityRevocationRegistry", () => {
  test("isRevoked returns false for unregistered ids", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    expect(await reg.isRevoked(capabilityId("missing"))).toBe(false);
  });

  test("revoke without cascade only revokes that id", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.revoke(capabilityId("A"), false);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("B"))).toBe(false);
  });

  test("revoke with cascade revokes all descendants", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.register(mkToken("C", "B"));
    await reg.revoke(capabilityId("A"), true);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("B"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("C"))).toBe(true);
  });

  test("cascade revoking middle node leaves root alive", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.register(mkToken("C", "B"));
    await reg.revoke(capabilityId("B"), true);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(false);
    expect(await reg.isRevoked(capabilityId("B"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("C"))).toBe(true);
  });

  test("register is idempotent", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("A"));
    await reg.revoke(capabilityId("A"), false);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(true);
  });

  test("cascade with diamond ancestry visits each node once", async () => {
    // A → B, A → C, B → D (we model only single-parent edges via parentId)
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.register(mkToken("C", "A"));
    await reg.register(mkToken("D", "B"));
    await reg.revoke(capabilityId("A"), true);
    for (const id of ["A", "B", "C", "D"] as const) {
      expect(await reg.isRevoked(capabilityId(id))).toBe(true);
    }
  });

  test("late-registered descendant inherits revoked state (codex round-1: high)", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.revoke(capabilityId("A"), true);
    // Register B as a child of A *after* A is revoked — should be DOA.
    await reg.register(mkToken("B", "A"));
    expect(await reg.isRevoked(capabilityId("B"))).toBe(true);
    // Grandchild registered later inherits transitively.
    await reg.register(mkToken("C", "B"));
    expect(await reg.isRevoked(capabilityId("C"))).toBe(true);
  });

  test("out-of-order parent attachment cascades to existing children (codex round-3: medium)", async () => {
    // Sequence: revoke A → register C as child of B (B unknown) →
    // register B as child of A. Round-2 marked B revoked but left C
    // alive because the parents-walk only ran for the token being
    // registered. Round-3 cascades through existing children.
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.revoke(capabilityId("A"), true);
    // C registered before B exists — at this point C has no known
    // ancestor chain leading to A.
    await reg.register(mkToken("C", "B"));
    expect(await reg.isRevoked(capabilityId("C"))).toBe(false);
    // Now B is registered under A. A is revoked, so B inherits revoked,
    // and that revocation must cascade into the already-known descendant
    // C — otherwise C remains a stale live grant despite a revoked
    // ancestor.
    await reg.register(mkToken("B", "A"));
    expect(await reg.isRevoked(capabilityId("B"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("C"))).toBe(true);
  });
});
