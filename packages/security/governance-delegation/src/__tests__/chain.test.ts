import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { CapabilityToken, SessionId } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { delegateCapability, issueRootCapability } from "../issue.js";
import { createMemoryCapabilityRevocationRegistry } from "../revocation.js";
import { createGlobScopeChecker } from "../scope-checker.js";
import type { CapabilitySigner as Signer } from "../signer.js";
import { createCapabilityVerifier } from "../verifier.js";

describe("end-to-end chain A → B → C", () => {
  const SESSION = sessionId("sess-1");
  const ACTIVE = (): ReadonlySet<SessionId> => new Set([SESSION]);

  async function buildChain(): Promise<{
    signer: Signer;
    A: CapabilityToken;
    B: CapabilityToken;
    C: CapabilityToken;
    registry: ReturnType<typeof createMemoryCapabilityRevocationRegistry>;
  }> {
    const signer: Signer = { kind: "hmac-sha256", secret: new Uint8Array(randomBytes(32)) };
    const registry = createMemoryCapabilityRevocationRegistry();
    const A = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file", "write_file"] },
        sessionId: SESSION,
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      registry,
      now: () => 1000,
    });

    const bResult = await delegateCapability({
      signer,
      parent: A,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file", "write_file"] },
        sessionId: SESSION,
      },
      ttlMs: 30_000,
      registry,
      now: () => 1000,
    });
    if (!bResult.ok) throw new Error(`B issue failed: ${JSON.stringify(bResult.error)}`);

    const cResult = await delegateCapability({
      signer,
      parent: bResult.value,
      delegateeId: agentId("carol"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: SESSION,
      },
      ttlMs: 10_000,
      registry,
      now: () => 1000,
    });
    if (!cResult.ok) throw new Error(`C issue failed: ${JSON.stringify(cResult.error)}`);

    return { signer, A, B: bResult.value, C: cResult.value, registry };
  }

  test("each level verifies independently with the same verifier", async () => {
    const { signer, A, B, C, registry } = await buildChain();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret, rootIssuer: agentId("engine") },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
      tokenStore: registry,
    });
    const ctx = { toolId: "read_file", now: 1500, activeSessionIds: ACTIVE() };
    expect((await verifier.verify(A, ctx)).ok).toBe(true);
    expect((await verifier.verify(B, ctx)).ok).toBe(true);
    expect((await verifier.verify(C, ctx)).ok).toBe(true);
  });

  test("chain depth increments correctly", async () => {
    const { A, B, C } = await buildChain();
    expect(A.chainDepth).toBe(0);
    expect(B.chainDepth).toBe(1);
    expect(C.chainDepth).toBe(2);
    expect(B.parentId).toBe(A.id);
    expect(C.parentId).toBe(B.id);
  });

  test("revoking A with cascade invalidates B and C", async () => {
    const { signer, A, B, C, registry } = await buildChain();
    if (signer.kind !== "hmac-sha256") throw new Error();
    await registry.revoke(A.id, true);
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret, rootIssuer: agentId("engine") },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
      tokenStore: registry,
    });
    const ctx = { toolId: "read_file", now: 1500, activeSessionIds: ACTIVE() };
    for (const tok of [A, B, C]) {
      const r = await verifier.verify(tok, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("revoked");
    }
  });

  test("revoking B with cascade leaves A valid; B and C revoked", async () => {
    const { signer, A, B, C, registry } = await buildChain();
    if (signer.kind !== "hmac-sha256") throw new Error();
    await registry.revoke(B.id, true);
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret, rootIssuer: agentId("engine") },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
      tokenStore: registry,
    });
    const ctx = { toolId: "read_file", now: 1500, activeSessionIds: ACTIVE() };
    expect((await verifier.verify(A, ctx)).ok).toBe(true);
    const rB = await verifier.verify(B, ctx);
    expect(rB.ok).toBe(false);
    if (!rB.ok) expect(rB.reason).toBe("revoked");
    const rC = await verifier.verify(C, ctx);
    expect(rC.ok).toBe(false);
    if (!rC.ok) expect(rC.reason).toBe("revoked");
  });

  test("widening at any chain level is rejected at issue time", async () => {
    const { signer, A } = await buildChain();
    const widen = await delegateCapability({
      signer,
      parent: A,
      delegateeId: agentId("bob"),
      scope: { permissions: { allow: ["bash"] }, sessionId: SESSION }, // bash not in parent
      ttlMs: 30_000,
      now: () => 1000,
    });
    expect(widen.ok).toBe(false);
    if (widen.ok) return;
    expect((widen.error.context as { reason: string }).reason).toBe("scope_exceeded");
  });
});
