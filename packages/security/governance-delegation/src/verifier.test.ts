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
