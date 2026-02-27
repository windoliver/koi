/**
 * Ed25519 CapabilityVerifier tests.
 *
 * Tests all 6 DelegationDenyReason variants plus Ed25519-specific cases,
 * matching the same structure as hmac-verifier.test.ts:
 * - proof_type_unsupported (non-ed25519 proof)
 * - invalid_signature (tampered signature or wrong key)
 * - expired (expiresAt <= now)
 * - session_invalid (sessionId not in activeSessionIds)
 * - chain_depth_exceeded (chainDepth > maxChainDepth)
 * - scope_exceeded (toolId not in scope)
 * - ok: true (all checks pass)
 */

import { describe, expect, test } from "bun:test";
import { sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import type { CapabilityToken, VerifyContext } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { createEd25519Verifier } from "../ed25519-verifier.js";

const NOW = 1700000000000;
const FUTURE = NOW + 3600000;
const PAST = NOW - 1000;
const SESSION_1 = sessionId("session-1");

/**
 * Generate a test Ed25519 keypair. Returns public/private key as base64-encoded DER.
 */
function generateTestKeypair(): { publicKeyB64: string; privateKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  return {
    publicKeyB64: Buffer.from(publicKey).toString("base64"),
    privateKeyB64: Buffer.from(privateKey).toString("base64"),
  };
}

const { publicKeyB64, privateKeyB64 } = generateTestKeypair();
// Second keypair for wrong-key tests
const { publicKeyB64: wrongPublicKeyB64, privateKeyB64: wrongPrivateKeyB64 } =
  generateTestKeypair();

/**
 * Sorts object keys deterministically for canonical JSON (matches ed25519-verifier.ts).
 */
function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const s: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    s[k] = sortKeys((v as Record<string, unknown>)[k]);
  }
  return s;
}

/**
 * Signs a token with the given private key (base64-encoded DER PKCS8).
 */
function signToken(
  token: Omit<CapabilityToken, "proof">,
  privateKeyB64Param: string = privateKeyB64,
  publicKeyB64Param: string = publicKeyB64,
): CapabilityToken {
  const canonical = JSON.stringify(sortKeys(token));
  const signature = cryptoSign(
    null, // null = use key's native algorithm (Ed25519 has built-in hash)
    Buffer.from(canonical),
    { key: Buffer.from(privateKeyB64Param, "base64"), format: "der", type: "pkcs8" },
  ).toString("base64");
  return { ...token, proof: { kind: "ed25519", publicKey: publicKeyB64Param, signature } };
}

function makeToken(overrides?: Partial<CapabilityToken>): CapabilityToken {
  const base: Omit<CapabilityToken, "proof"> = {
    id: capabilityId("cap-1"),
    issuerId: agentId("agent-issuer"),
    delegateeId: agentId("agent-delegatee"),
    scope: {
      permissions: { allow: ["read_file", "write_file"] },
      sessionId: SESSION_1,
    },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: NOW - 1000,
    expiresAt: FUTURE,
    ...overrides,
  };
  return signToken(base);
}

function makeContext(overrides?: Partial<VerifyContext>): VerifyContext {
  return {
    toolId: "read_file",
    now: NOW,
    activeSessionIds: new Set([SESSION_1]),
    ...overrides,
  };
}

const verifier = createEd25519Verifier();

describe("createEd25519Verifier", () => {
  test("ok: true — valid token, matching tool, active session", async () => {
    const token = makeToken();
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.id).toBe(token.id);
    }
  });

  test("proof_type_unsupported — hmac-sha256 proof returns unsupported", async () => {
    const token: CapabilityToken = {
      id: capabilityId("cap-2"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
      proof: { kind: "hmac-sha256", digest: "a".repeat(64) },
    };
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proof_type_unsupported");
  });

  test("proof_type_unsupported — nexus proof returns unsupported", async () => {
    const token: CapabilityToken = {
      id: capabilityId("cap-3"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
      proof: { kind: "nexus", token: "nexus-tok" },
    };
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proof_type_unsupported");
  });

  test("invalid_signature — tampered signature returns invalid_signature", async () => {
    const token = makeToken();
    const tampered: CapabilityToken = {
      ...token,
      proof: {
        kind: "ed25519",
        publicKey: publicKeyB64,
        signature:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const result = await verifier.verify(tampered, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("invalid_signature — wrong private key used to sign returns invalid_signature", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-4"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    // Sign with wrong key, embed correct public key → signature won't verify
    const wrongSigned = signToken(base, wrongPrivateKeyB64, publicKeyB64);
    const result = await verifier.verify(wrongSigned, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("invalid_signature — signature for different payload returns invalid_signature", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-4b"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    // Sign correctly, then mutate a field so the payload no longer matches
    const original = signToken(base);
    const tampered: CapabilityToken = {
      ...original,
      // Steal the signature but change the token ID → payload mismatch
      id: capabilityId("cap-4b-tampered"),
    };
    const result = await verifier.verify(tampered, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("expired — expiresAt < now returns expired", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-5"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: PAST - 2000,
      expiresAt: PAST,
    };
    const token = signToken(base);
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("expired — expiresAt === now returns expired (boundary condition)", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-6"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: PAST,
      expiresAt: NOW, // exactly now = expired
    };
    const token = signToken(base);
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("session_invalid — sessionId not in activeSessionIds", async () => {
    const token = makeToken();
    const result = await verifier.verify(
      token,
      makeContext({ activeSessionIds: new Set([sessionId("other-session")]) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_invalid");
  });

  test("session_invalid — empty activeSessionIds set", async () => {
    const token = makeToken();
    const result = await verifier.verify(token, makeContext({ activeSessionIds: new Set() }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_invalid");
  });

  test("chain_depth_exceeded — chainDepth > maxChainDepth", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-7"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 5,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    const token = signToken(base);
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_depth_exceeded");
  });

  test("scope_exceeded — tool not in allow list", async () => {
    const token = makeToken();
    const result = await verifier.verify(token, makeContext({ toolId: "execute_command" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });

  test("scope_exceeded — tool in deny list overrides allow", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-8"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: {
        permissions: { allow: ["read_file", "write_file"], deny: ["write_file"] },
        sessionId: SESSION_1,
      },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    const token = signToken(base);
    const result = await verifier.verify(token, makeContext({ toolId: "write_file" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });

  test("wildcard allow — '*' permits any tool", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-9"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["*"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    const token = signToken(base);
    const result = await verifier.verify(token, makeContext({ toolId: "any_exotic_tool" }));
    expect(result.ok).toBe(true);
  });

  test("checks are ordered — tampered proof fails before expiry check", async () => {
    // Expired + tampered — should fail with invalid_signature (proof checked first)
    const token: CapabilityToken = {
      id: capabilityId("cap-10"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: PAST - 2000,
      expiresAt: PAST, // expired
      proof: { kind: "ed25519", publicKey: publicKeyB64, signature: "invalidsig==" },
    };
    const result = await verifier.verify(token, makeContext());
    // invalid_signature checked before expired
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("verifies with correct matching keypair — different key pair test", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-11"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    // Sign with second keypair — it has its own public key embedded, should verify
    const token = signToken(base, wrongPrivateKeyB64, wrongPublicKeyB64);
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(true);
  });
});
