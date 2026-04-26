import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { CapabilityToken, SessionId, VerifyContext } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { issueRootCapability } from "./issue.js";
import { createMemoryCapabilityRevocationRegistry } from "./revocation.js";
import { createGlobScopeChecker } from "./scope-checker.js";
import type { CapabilitySigner as Signer } from "./signer.js";
import { createCapabilityVerifier } from "./verifier.js";

const ACTIVE = (s: SessionId): ReadonlySet<SessionId> => new Set([s]);

const ctx = (overrides: Partial<VerifyContext> = {}): VerifyContext => ({
  toolId: "read_file",
  now: 1500,
  activeSessionIds: ACTIVE(sessionId("sess-1")),
  ...overrides,
});

const newHmacRoot = async (): Promise<{
  signer: Signer;
  token: CapabilityToken;
}> => {
  const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
  const token = await issueRootCapability({
    signer,
    issuerId: agentId("engine"),
    delegateeId: agentId("alice"),
    scope: {
      permissions: { allow: ["read_file"] },
      sessionId: sessionId("sess-1"),
    },
    ttlMs: 60_000,
    maxChainDepth: 3,
    now: () => 1000,
  });
  return { signer, token };
};

describe("createCapabilityVerifier", () => {
  test("ok=true for valid HMAC token + matching toolId + active session", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(true);
  });

  test("ok=false invalid_signature when secret differs", async () => {
    const { token } = await newHmacRoot();
    const verifier = createCapabilityVerifier({
      hmac: { secret: randomBytes(32) },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("ok=false expired when now >= expiresAt", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx({ now: 100_000 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired");
  });

  test("ok=false invalid_signature when now < createdAt", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx({ now: 500 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("ok=false session_invalid when sessionId not active", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(
      token,
      ctx({ activeSessionIds: new Set([sessionId("OTHER")]) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session_invalid");
  });

  test("ok=false scope_exceeded when toolId not in allow", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx({ toolId: "bash" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_exceeded");
  });

  test("ok=false revoked when registry says so", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(token);
    await reg.revoke(token.id, false);
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      revocations: reg,
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("revoked");
  });

  test("ok=false proof_type_unsupported when verifier lacks key for proof.kind", async () => {
    const { token } = await newHmacRoot();
    const verifier = createCapabilityVerifier({
      // No hmac key configured.
      ed25519: { publicKeys: new Map(), issuerKeys: new Map(), rootKeys: new Set() },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_type_unsupported");
  });

  test("ok=false proof_type_unsupported for nexus proofs", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const nexusToken: CapabilityToken = {
      ...token,
      proof: { kind: "nexus", token: "opaque" },
    };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(nexusToken, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_type_unsupported");
  });

  test("ed25519 token verifies", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([[fp, pubDer]]),
        issuerKeys: new Map([[fp, agentId("engine")]]),
        rootKeys: new Set([fp]),
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(true);
  });
});

describe("authority binding (codex round-1: critical)", () => {
  test("HMAC rootIssuer enforced — mismatch rejected", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret, rootIssuer: agentId("not-engine") },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("Ed25519 issuerKeys binding enforced — wrong AgentId rejected", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("attacker"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["*"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([[fp, pubDer]]),
        issuerKeys: new Map([[fp, agentId("engine")]]),
        rootKeys: new Set([fp]),
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("Ed25519 unbound fingerprint rejected when issuerKeys configured", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["*"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([[fp, pubDer]]),
        issuerKeys: new Map(), // empty — fingerprint not authorized
        rootKeys: new Set([fp]),
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });
});

describe("chain validation (codex round-1: critical)", () => {
  test("chainDepth>0 token without tokenStore rejected as unknown_grant", async () => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const registry = createMemoryCapabilityRevocationRegistry();
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      registry,
      now: () => 1000,
    });
    const { delegateCapability } = await import("./issue.js");
    const childResult = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 30_000,
      registry,
      now: () => 1000,
    });
    if (!childResult.ok) throw new Error("issuance failed");
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      // no tokenStore configured
    });
    const result = await verifier.verify(childResult.value, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_grant");
  });

  test("forged child with non-existent parentId rejected", async () => {
    const { signer, token: root } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const registry = createMemoryCapabilityRevocationRegistry();
    await registry.register(root);
    // Build a forged "child" pointing at a parent the store doesn't know.
    const forged = {
      ...root,
      id: root.id, // re-use id intentionally to make it a different token
      issuerId: agentId("alice"),
      delegateeId: agentId("eve"),
      parentId: root.id, // dangling — but we'll use a non-existent parentId below
      chainDepth: 1,
    };
    // Re-sign so signature is valid but parent lookup fails.
    const { signHmac } = await import("./hmac.js");
    const danglingId = "dangling-cap-id" as typeof root.id;
    const tampered = { ...forged, parentId: danglingId };
    const digest = signHmac(tampered, signer.secret);
    const finalToken = { ...tampered, proof: { kind: "hmac-sha256" as const, digest } };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      tokenStore: registry,
    });
    const result = await verifier.verify(finalToken, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_grant");
  });

  test("forged child claiming wider scope than parent rejected at verify time", async () => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const registry = createMemoryCapabilityRevocationRegistry();
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      registry,
      now: () => 1000,
    });
    // Forge a child claiming chainDepth=1 with widened scope, sign it directly
    // (bypassing delegateCapability's attenuation check). Verifier must reject.
    const { signHmac } = await import("./hmac.js");
    const { capabilityId } = await import("@koi/core");
    const forgedUnsigned = {
      id: capabilityId("forged-1"),
      issuerId: agentId("alice"),
      delegateeId: agentId("eve"),
      scope: {
        permissions: { allow: ["read_file", "write_file", "bash"] },
        sessionId: sessionId("sess-1"),
      },
      parentId: root.id,
      chainDepth: 1,
      maxChainDepth: 3,
      createdAt: 1000,
      expiresAt: 30_000,
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const digest = signHmac(forgedUnsigned, signer.secret);
    const forged = { ...forgedUnsigned, proof: { kind: "hmac-sha256" as const, digest } };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      tokenStore: registry,
    });
    const result = await verifier.verify(forged, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_exceeded");
  });
});

describe("round-2 hardening", () => {
  test("Ed25519 cross-issuer forgery rejected (codex round-2: critical)", async () => {
    // Two distinct configured Ed25519 keys, bound to two distinct AgentIds.
    // Attacker uses key-A's secret to sign a token claiming issuerId=B.
    // Verifier must reject — without per-token issuer-key binding, the
    // signature would verify (key-A is configured) and the chain-walk
    // continuity check (parent.delegateeId === child.issuerId) would pass.
    const kpA = generateKeyPairSync("ed25519");
    const kpB = generateKeyPairSync("ed25519");
    const pubA = kpA.publicKey.export({ format: "der", type: "spki" });
    const pubB = kpB.publicKey.export({ format: "der", type: "spki" });
    const privA = kpA.privateKey.export({ format: "der", type: "pkcs8" });
    const fpA = Buffer.from(pubA).toString("base64");
    const fpB = Buffer.from(pubB).toString("base64");

    // Sign with key-A but claim issuerId="agent-b" (the AgentId bound to key-B).
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privA, publicKeyFingerprint: fpA },
      issuerId: agentId("agent-b"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([
          [fpA, pubA],
          [fpB, pubB],
        ]),
        issuerKeys: new Map([
          [fpA, agentId("agent-a")],
          [fpB, agentId("agent-b")],
        ]),
        rootKeys: new Set([fpA, fpB]),
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("forged child exceeding parent.maxChainDepth rejected (codex round-2: high)", async () => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const registry = createMemoryCapabilityRevocationRegistry();
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 1, // root permits only one level of delegation
      registry,
      now: () => 1000,
    });
    const { signHmac } = await import("./hmac.js");
    const { capabilityId } = await import("@koi/core");
    // Forge a depth-2 child claiming chainDepth=2 from a chainDepth=0 root —
    // delegateCapability would refuse, but a malicious holder with the secret
    // can mint it directly. Verifier must catch it.
    const forgedUnsigned = {
      id: capabilityId("forged-depth"),
      issuerId: agentId("alice"),
      delegateeId: agentId("eve"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      parentId: root.id,
      chainDepth: 2, // root.chainDepth + 1 should be 1, not 2
      maxChainDepth: 5, // also widening the budget
      createdAt: 1000,
      expiresAt: 30_000,
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const digest = signHmac(forgedUnsigned, signer.secret);
    const forged = { ...forgedUnsigned, proof: { kind: "hmac-sha256" as const, digest } };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      tokenStore: registry,
    });
    const result = await verifier.verify(forged, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("Ed25519 publicKeys-only mode is no longer permitted — issuerKeys is required (codex round-3: critical)", async () => {
    // Round-2 left issuerKeys optional. Round-3 closes the fail-open path:
    // configuring publicKeys without issuerKeys would have allowed any
    // configured key to sign any claimed issuerId. The TypeScript shape is
    // now required, but at runtime an attacker-supplied empty issuerKeys
    // map must still reject every Ed25519 token (no fingerprint bound).
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([[fp, pubDer]]),
        issuerKeys: new Map(), // empty — fingerprint not bound
        rootKeys: new Set([fp]),
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("non-finite timestamps rejected at verify time (codex round-3: high)", async () => {
    // Without explicit Number.isFinite gating, NaN expiresAt would make
    // both `now < createdAt` and `now >= expiresAt` evaluate false, so a
    // signed token with NaN expiry would verify indefinitely.
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const { signHmac } = await import("./hmac.js");
    const { capabilityId } = await import("@koi/core");
    const unsigned = {
      id: capabilityId("nan-token"),
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: 1000,
      expiresAt: Number.NaN, // forged
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const digest = signHmac(unsigned, signer.secret);
    const forged = { ...unsigned, proof: { kind: "hmac-sha256" as const, digest } };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(forged, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("malformed parent permissions cannot widen child authority (codex round-8: high)", async () => {
    // Codex round-7 added a shape guard for the leaf token, but the
    // ancestors loaded via tokenStore bypassed that boundary. A signed
    // malformed parent with `allow: "*"` (string instead of array) would
    // be treated as a wildcard inside L0's `new Set(parent.allow ?? [])`
    // — a well-formed child claiming `allow: ["bash"]` could then verify
    // for bash even though the malformed parent itself would not. Fix:
    // run shape validation on every ancestor.
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const { signHmac } = await import("./hmac.js");
    const { capabilityId } = await import("@koi/core");
    const malformedParentId = capabilityId("malformed-parent");
    const malformedUnsigned = {
      id: malformedParentId,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      // permissions.allow is a STRING — bypasses Array.isArray, but
      // L0's helper would build new Set("*") and treat it as wildcard.
      scope: { permissions: { allow: "*" }, sessionId: sessionId("sess-1") },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: 1000,
      expiresAt: 60_000,
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const malformedDigest = signHmac(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
      malformedUnsigned as any,
      signer.secret,
    );
    const malformedParent = {
      ...malformedUnsigned,
      proof: { kind: "hmac-sha256" as const, digest: malformedDigest },
    };
    // Custom store: returns the malformed parent for any lookup of its id.
    const store = {
      get: async (id: typeof malformedParentId) =>
        // biome-ignore lint/suspicious/noExplicitAny: malformed by design
        id === malformedParentId ? (malformedParent as any) : undefined,
    };

    // Well-formed child claims allow:["bash"] and parent=malformed.
    const childUnsigned = {
      id: capabilityId("forged-child-malformed-parent"),
      issuerId: agentId("alice"),
      delegateeId: agentId("eve"),
      scope: { permissions: { allow: ["bash"] }, sessionId: sessionId("sess-1") },
      parentId: malformedParentId,
      chainDepth: 1,
      maxChainDepth: 3,
      createdAt: 1000,
      expiresAt: 30_000,
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const childDigest = signHmac(childUnsigned, signer.secret);
    const child = {
      ...childUnsigned,
      proof: { kind: "hmac-sha256" as const, digest: childDigest },
    };

    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      tokenStore: store,
    });
    const result = await verifier.verify(child, ctx({ toolId: "bash" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("malformed input fails closed instead of throwing (codex round-7: high)", async () => {
    // Tokens deserialized from network/disk bypass the TypeScript type
    // system. Without explicit shape validation, dereferencing a missing
    // proof.kind would throw, and any upstream "deny on throw" policy
    // could fail open. Every malformed shape must yield a deny result.
    const verifier = createCapabilityVerifier({
      hmac: { secret: randomBytes(32) },
      scopeChecker: createGlobScopeChecker(),
    });
    const cases: Array<unknown> = [
      null,
      undefined,
      "string",
      42,
      {}, // empty object
      { id: "x" }, // missing everything else
      { id: "x", issuerId: "a", delegateeId: "b", scope: {}, proof: { kind: "hmac-sha256" } }, // missing scope.permissions/sessionId
      {
        id: "x",
        issuerId: "a",
        delegateeId: "b",
        scope: { permissions: { allow: ["*"] }, sessionId: "s" },
        // missing proof entirely
      },
      {
        id: "x",
        issuerId: "a",
        delegateeId: "b",
        scope: { permissions: { allow: ["*"] }, sessionId: "s" },
        proof: null,
      },
      {
        id: "x",
        issuerId: "a",
        delegateeId: "b",
        scope: { permissions: { allow: ["*"] }, sessionId: "s" },
        proof: {}, // proof without kind
      },
    ];
    for (const malformed of cases) {
      // biome-ignore lint/suspicious/noExplicitAny: malformed input by design
      const result = await verifier.verify(malformed as any, ctx());
      expect(result.ok).toBe(false);
    }
  });

  test("tokenStore.get returning a different-id token rejected (codex round-6: high)", async () => {
    // A stale or buggy tokenStore could return a valid but unrelated
    // token for an unknown parentId lookup. Without binding parent.id
    // to child.parentId after the lookup, the signed child would verify
    // against the wrong parent.
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const real = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["*"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const { signHmac } = await import("./hmac.js");
    const { capabilityId } = await import("@koi/core");

    // Forge a child claiming parentId='dangling' (not the real root's id).
    const danglingId = capabilityId("dangling");
    const forgedUnsigned = {
      id: capabilityId("forged-store-mismatch"),
      issuerId: agentId("alice"),
      delegateeId: agentId("eve"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      parentId: danglingId,
      chainDepth: 1,
      maxChainDepth: 3,
      createdAt: 1000,
      expiresAt: 30_000,
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const digest = signHmac(forgedUnsigned, signer.secret);
    const forged = { ...forgedUnsigned, proof: { kind: "hmac-sha256" as const, digest } };

    // Buggy tokenStore: returns the real root for any id, including the
    // dangling lookup. Must NOT be sufficient to verify the forged child.
    const buggyStore = {
      get: async () => real,
    };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      tokenStore: buggyStore,
    });
    const result = await verifier.verify(forged, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_grant");
  });

  test("Ed25519 delegatee key cannot mint root (codex round-5: critical)", async () => {
    // Setup: two Ed25519 keys configured. Engine's key (fpEngine) is the
    // sanctioned root authority. Delegatee's key (fpDelegatee) is in
    // issuerKeys — legitimate for chain delegation — but NOT in rootKeys.
    // The delegatee must not be able to self-sign a parentless wildcard
    // root; verifyRootAuthority must reject it.
    const kpEngine = generateKeyPairSync("ed25519");
    const kpDelegatee = generateKeyPairSync("ed25519");
    const pubEngine = kpEngine.publicKey.export({ format: "der", type: "spki" });
    const pubDelegatee = kpDelegatee.publicKey.export({ format: "der", type: "spki" });
    const privDelegatee = kpDelegatee.privateKey.export({ format: "der", type: "pkcs8" });
    const fpEngine = Buffer.from(pubEngine).toString("base64");
    const fpDelegatee = Buffer.from(pubDelegatee).toString("base64");

    // Delegatee self-signs a chainDepth=0 wildcard token. Issuer-key
    // binding holds (fpDelegatee → agent("delegatee") matches issuerId).
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDelegatee, publicKeyFingerprint: fpDelegatee },
      issuerId: agentId("delegatee"),
      delegateeId: agentId("eve"),
      scope: { permissions: { allow: ["*"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([
          [fpEngine, pubEngine],
          [fpDelegatee, pubDelegatee],
        ]),
        issuerKeys: new Map([
          [fpEngine, agentId("engine")],
          [fpDelegatee, agentId("delegatee")],
        ]),
        rootKeys: new Set([fpEngine]), // delegatee NOT authorized to root-sign
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("requiresPoP token rejected as proof_type_unsupported (codex round-5+6: high)", async () => {
    // PoP challenge flow is deferred. A signed token whose issuer
    // explicitly opted into PoP (`requiresPoP: true`) MUST be rejected
    // — accepting it as plain bearer silently downgrades the contract.
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const popToken: CapabilityToken = { ...token, requiresPoP: true };
    // Re-sign so the token is internally valid except for PoP.
    const { signHmac } = await import("./hmac.js");
    const digest = signHmac(popToken, signer.secret);
    const finalToken: CapabilityToken = {
      ...popToken,
      proof: { kind: "hmac-sha256", digest },
    };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(finalToken, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_type_unsupported");
  });

  test("Ed25519 root rejected when rootKeys is empty set (codex round-5: critical)", async () => {
    // HMAC-only deployment: explicit empty rootKeys means no Ed25519
    // chainDepth=0 token can verify, even if its key is otherwise valid
    // for chain delegation.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: {
        publicKeys: new Map([[fp, pubDer]]),
        issuerKeys: new Map([[fp, agentId("engine")]]),
        rootKeys: new Set(), // explicit: no Ed25519 root tokens accepted
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("forged child stripping parent.ask rejected at verify time (codex round-4: critical)", async () => {
    // Parent says ask:["bash"]. Forged child claims allow:["*"] and no ask
    // — bypassing the human-approval gate. delegateCapability would refuse
    // (issue-time ask preservation), but a malicious holder of the secret
    // can mint the child directly. The verifier must reject it via chain
    // attenuation.
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const registry = createMemoryCapabilityRevocationRegistry();
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["*"], ask: ["bash"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      registry,
      now: () => 1000,
    });
    const { signHmac } = await import("./hmac.js");
    const { capabilityId } = await import("@koi/core");
    const forgedUnsigned = {
      id: capabilityId("forged-ask-strip"),
      issuerId: agentId("alice"),
      delegateeId: agentId("eve"),
      // Note: no `ask` — strips parent.ask:["bash"].
      scope: { permissions: { allow: ["*"] }, sessionId: sessionId("sess-1") },
      parentId: root.id,
      chainDepth: 1,
      maxChainDepth: 3,
      createdAt: 1000,
      expiresAt: 30_000,
      proof: { kind: "hmac-sha256" as const, digest: "" },
    };
    const digest = signHmac(forgedUnsigned, signer.secret);
    const forged = { ...forgedUnsigned, proof: { kind: "hmac-sha256" as const, digest } };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      tokenStore: registry,
    });
    const result = await verifier.verify(forged, ctx({ toolId: "bash" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_exceeded");
  });

  test("non-finite ttlMs rejected at issue time (codex round-3: high)", async () => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    await expect(
      issueRootCapability({
        signer,
        issuerId: agentId("engine"),
        delegateeId: agentId("alice"),
        scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
        ttlMs: Number.NaN, // would produce expiresAt=NaN
        maxChainDepth: 3,
      }),
    ).rejects.toThrow();
  });

  test("default scope checker rejects resource-scoped tokens (codex round-2: high)", async () => {
    // Resource-scoped tokens require a resource-aware ScopeChecker — the
    // default glob checker has no requested-resource projection from
    // VerifyContext, so it must fail closed rather than silently allowing
    // a tool match while ignoring the resource constraint.
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file"] },
        resources: ["read_file:/safe/**"],
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_exceeded");
  });
});
