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
      ed25519: { publicKeys: new Map() },
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
      ed25519: { publicKeys: new Map([[fp, pubDer]]) },
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

  test("Ed25519 rootIssuers binding enforced — wrong AgentId rejected", async () => {
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
        rootIssuers: new Map([[fp, agentId("engine")]]),
      },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("Ed25519 unbound fingerprint rejected when rootIssuers configured", async () => {
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
        rootIssuers: new Map(), // empty — fingerprint not authorized
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
