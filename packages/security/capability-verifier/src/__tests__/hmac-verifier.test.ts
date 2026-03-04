/**
 * HMAC-SHA256 CapabilityVerifier tests.
 *
 * Tests all 6 DelegationDenyReason variants plus HMAC-specific cases:
 * - proof_type_unsupported (non-hmac proof)
 * - invalid_signature (tampered digest)
 * - expired (expiresAt <= now)
 * - session_invalid (sessionId not in activeSessionIds)
 * - chain_depth_exceeded (chainDepth > maxChainDepth)
 * - scope_exceeded (toolId not in scope)
 * - ok: true (all checks pass)
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { CapabilityToken, VerifyContext } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { createHmacVerifier } from "../hmac-verifier.js";

const SECRET = "test-hmac-secret-32-bytes-minimum";
const NOW = 1700000000000;
const FUTURE = NOW + 3600000;
const PAST = NOW - 1000;
const SESSION_1 = sessionId("session-1");

function makeSigned(token: Omit<CapabilityToken, "proof">, secret = SECRET): CapabilityToken {
  const sortKeys = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sortKeys);
    const s: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      s[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return s;
  };
  const canonical = JSON.stringify(sortKeys(token));
  const digest = createHmac("sha256", secret).update(canonical).digest("hex");
  return { ...token, proof: { kind: "hmac-sha256", digest } };
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
  return makeSigned(base);
}

function makeContext(overrides?: Partial<VerifyContext>): VerifyContext {
  return {
    toolId: "read_file",
    now: NOW,
    activeSessionIds: new Set([SESSION_1]),
    ...overrides,
  };
}

const verifier = createHmacVerifier(SECRET);

describe("createHmacVerifier", () => {
  test("ok: true — valid token, matching tool, active session", async () => {
    const token = makeToken();
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.id).toBe(token.id);
    }
  });

  test("proof_type_unsupported — nexus proof returns unsupported", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-2"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    const token: CapabilityToken = { ...base, proof: { kind: "nexus", token: "nexus-tok" } };
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proof_type_unsupported");
  });

  test("proof_type_unsupported — ed25519 proof returns unsupported (hmac verifier)", async () => {
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-3"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
    };
    const token: CapabilityToken = {
      ...base,
      proof: { kind: "ed25519", publicKey: "pk", signature: "sig" },
    };
    const result = await verifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proof_type_unsupported");
  });

  test("invalid_signature — tampered digest returns invalid_signature", async () => {
    const token = makeToken();
    const tampered: CapabilityToken = {
      ...token,
      proof: { kind: "hmac-sha256", digest: "0".repeat(64) },
    };
    const result = await verifier.verify(tampered, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("invalid_signature — empty digest returns invalid_signature", async () => {
    const token = makeToken();
    const tampered: CapabilityToken = {
      ...token,
      proof: { kind: "hmac-sha256", digest: "" },
    };
    const result = await verifier.verify(tampered, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("invalid_signature — wrong secret used to sign returns invalid_signature", async () => {
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
    const token = makeSigned(base, "wrong-secret-32-bytes-minimum---");
    const result = await verifier.verify(token, makeContext());
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
    const token = makeSigned(base);
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
    const token = makeSigned(base);
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
    const token = makeSigned(base);
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
    const token = makeSigned(base);
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
    const token = makeSigned(base);
    const result = await verifier.verify(token, makeContext({ toolId: "any_exotic_tool" }));
    expect(result.ok).toBe(true);
  });

  test("checks are ordered — tampered proof fails before expiry check", async () => {
    // Expired + tampered — should fail with invalid_signature (proof checked first)
    const base: Omit<CapabilityToken, "proof"> = {
      id: capabilityId("cap-10"),
      issuerId: agentId("agent-issuer"),
      delegateeId: agentId("agent-delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: PAST - 2000,
      expiresAt: PAST, // expired
    };
    const token: CapabilityToken = {
      ...base,
      proof: { kind: "hmac-sha256", digest: "0".repeat(64) }, // tampered
    };
    const result = await verifier.verify(token, makeContext());
    // invalid_signature checked before expired
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });
});

// ─────────────────────────────────────────────────────────────
// ScopeChecker injection (Issue #700)
// ─────────────────────────────────────────────────────────────

describe("createHmacVerifier — scopeChecker injection", () => {
  test("sync scopeChecker allows tool", async () => {
    const scopeCheckerVerifier = createHmacVerifier(SECRET, {
      isAllowed: () => true,
    });
    const token = makeToken();
    const result = await scopeCheckerVerifier.verify(
      token,
      makeContext({ toolId: "unknown_tool" }),
    );
    expect(result.ok).toBe(true);
  });

  test("sync scopeChecker denies tool", async () => {
    const scopeCheckerVerifier = createHmacVerifier(SECRET, {
      isAllowed: () => false,
    });
    const token = makeToken();
    const result = await scopeCheckerVerifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });

  test("async scopeChecker is awaited", async () => {
    const scopeCheckerVerifier = createHmacVerifier(SECRET, {
      isAllowed: () => Promise.resolve(true),
    });
    const token = makeToken();
    const result = await scopeCheckerVerifier.verify(token, makeContext());
    expect(result.ok).toBe(true);
  });

  test("async scopeChecker deny is awaited", async () => {
    const scopeCheckerVerifier = createHmacVerifier(SECRET, {
      isAllowed: () => Promise.resolve(false),
    });
    const token = makeToken();
    const result = await scopeCheckerVerifier.verify(token, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });
});
