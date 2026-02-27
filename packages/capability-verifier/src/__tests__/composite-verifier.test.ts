/**
 * Composite verifier and in-memory verifier cache tests.
 *
 * Tests:
 * - createCompositeVerifier routes by proof.kind (hmac, ed25519, nexus)
 * - Cache: hit path returns cached result without re-computing
 * - Cache: set path stores result after first verification
 * - Cache: evict removes all entries for a tokenId
 * - createInMemoryVerifierCache: get/set/evict operations
 */

import { describe, expect, test } from "bun:test";
import { createHmac, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import type { CapabilityToken, VerifyContext } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { createCompositeVerifier, createInMemoryVerifierCache } from "../composite-verifier.js";

const HMAC_SECRET = "composite-test-secret-32-bytes!!";
const NOW = 1700000000000;
const FUTURE = NOW + 3600000;
const SESSION_1 = sessionId("session-1");

const { privateKey: ed25519Private, publicKey: ed25519Public } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "der" },
  publicKeyEncoding: { type: "spki", format: "der" },
});

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const s: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    s[k] = sortKeys((v as Record<string, unknown>)[k]);
  }
  return s;
}

function makeHmacToken(id: string): CapabilityToken {
  const base = {
    id: capabilityId(id),
    issuerId: agentId("issuer"),
    delegateeId: agentId("delegatee"),
    scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: NOW - 1000,
    expiresAt: FUTURE,
  };
  const canonical = JSON.stringify(sortKeys(base));
  const digest = createHmac("sha256", HMAC_SECRET).update(canonical).digest("hex");
  return { ...base, proof: { kind: "hmac-sha256", digest } };
}

function makeEd25519Token(id: string): CapabilityToken {
  const base = {
    id: capabilityId(id),
    issuerId: agentId("issuer"),
    delegateeId: agentId("delegatee"),
    scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: NOW - 1000,
    expiresAt: FUTURE,
  };
  const canonical = JSON.stringify(sortKeys(base));
  const signature = cryptoSign(null, Buffer.from(canonical), {
    key: Buffer.from(ed25519Private),
    format: "der",
    type: "pkcs8",
  }).toString("base64");
  const publicKeyB64 = Buffer.from(ed25519Public).toString("base64");
  return { ...base, proof: { kind: "ed25519", publicKey: publicKeyB64, signature } };
}

const defaultCtx: VerifyContext = {
  toolId: "read_file",
  now: NOW,
  activeSessionIds: new Set([SESSION_1]),
};

// ─────────────────────────────────────────────────────────────
// Routing by proof.kind
// ─────────────────────────────────────────────────────────────

describe("createCompositeVerifier — routing", () => {
  const composite = createCompositeVerifier({ hmacSecret: HMAC_SECRET });

  test("routes hmac-sha256 token through hmac verifier — ok: true", () => {
    const token = makeHmacToken("hmac-1");
    const result = composite.verify(token, defaultCtx);
    expect(result.ok).toBe(true);
  });

  test("routes ed25519 token through ed25519 verifier — ok: true", () => {
    const token = makeEd25519Token("ed25519-1");
    const result = composite.verify(token, defaultCtx);
    expect(result.ok).toBe(true);
  });

  test("nexus proof returns proof_type_unsupported", () => {
    const token: CapabilityToken = {
      id: capabilityId("nexus-1"),
      issuerId: agentId("issuer"),
      delegateeId: agentId("delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
      proof: { kind: "nexus", token: "nexus-bearer-xyz" },
    };
    const result = composite.verify(token, defaultCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proof_type_unsupported");
  });
});

// ─────────────────────────────────────────────────────────────
// Caching behavior
// ─────────────────────────────────────────────────────────────

describe("createCompositeVerifier — caching", () => {
  test("cache hit: second verify call returns cached result", () => {
    const cache = createInMemoryVerifierCache();
    const token = makeHmacToken("cache-test-1");

    // Wrap verify to count computations
    const composite = createCompositeVerifier({ hmacSecret: HMAC_SECRET, cache });

    // First call: computes and caches
    const result1 = composite.verify(token, defaultCtx);
    expect(result1.ok).toBe(true);

    // Manually confirm cache is populated
    const cached = cache.get(token.id, defaultCtx.toolId);
    expect(cached).toBeDefined();
    expect(cached?.ok).toBe(true);

    // Second call: returns cached result
    const result2 = composite.verify(token, defaultCtx);
    expect(result2.ok).toBe(true);
  });

  test("cache stores denial results too (deny caching)", () => {
    const cache = createInMemoryVerifierCache();
    const token: CapabilityToken = {
      id: capabilityId("cache-deny-1"),
      issuerId: agentId("issuer"),
      delegateeId: agentId("delegatee"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: SESSION_1 },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
      proof: { kind: "nexus", token: "nexus-xyz" }, // will be unsupported
    };
    const composite = createCompositeVerifier({ hmacSecret: HMAC_SECRET, cache });

    const result = composite.verify(token, defaultCtx);
    expect(result.ok).toBe(false);

    // Denial result cached
    const cached = cache.get(token.id, defaultCtx.toolId);
    expect(cached).toBeDefined();
    expect(cached?.ok).toBe(false);
  });

  test("cache evict removes all entries for tokenId", () => {
    const cache = createInMemoryVerifierCache();
    const token = makeHmacToken("evict-test-1");
    const composite = createCompositeVerifier({ hmacSecret: HMAC_SECRET, cache });

    // Verify with two different tools to populate cache with multiple entries
    composite.verify(token, { ...defaultCtx, toolId: "read_file" });
    composite.verify(token, { ...defaultCtx, toolId: "write_file" });

    expect(cache.get(token.id, "read_file")).toBeDefined();
    expect(cache.get(token.id, "write_file")).toBeDefined();

    cache.evict(token.id);

    // Both entries evicted
    expect(cache.get(token.id, "read_file")).toBeUndefined();
    expect(cache.get(token.id, "write_file")).toBeUndefined();
  });

  test("composite verifier exposes cache reference", () => {
    const cache = createInMemoryVerifierCache();
    const composite = createCompositeVerifier({ hmacSecret: HMAC_SECRET, cache });
    expect(composite.cache).toBe(cache);
  });

  test("composite verifier without cache has undefined cache", () => {
    const composite = createCompositeVerifier({ hmacSecret: HMAC_SECRET });
    expect(composite.cache).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// createInMemoryVerifierCache standalone tests
// ─────────────────────────────────────────────────────────────

describe("createInMemoryVerifierCache", () => {
  test("get returns undefined for missing entry", () => {
    const cache = createInMemoryVerifierCache();
    expect(cache.get(capabilityId("nonexistent"), "read_file")).toBeUndefined();
  });

  test("set and get round-trip", () => {
    const cache = createInMemoryVerifierCache();
    const result = { ok: true as const, token: makeHmacToken("store-test") };
    cache.set(capabilityId("store-test"), "read_file", result);
    expect(cache.get(capabilityId("store-test"), "read_file")).toBe(result);
  });

  test("different toolId keys are independent", () => {
    const cache = createInMemoryVerifierCache();
    const tokenId = capabilityId("multi-tool");
    const resultA = { ok: true as const, token: makeHmacToken("multi-tool") };
    const resultB = { ok: false as const, reason: "scope_exceeded" as const };
    cache.set(tokenId, "read_file", resultA);
    cache.set(tokenId, "write_file", resultB);
    expect(cache.get(tokenId, "read_file")).toBe(resultA);
    expect(cache.get(tokenId, "write_file")).toBe(resultB);
  });

  test("evict with no matching entries is a no-op", () => {
    const cache = createInMemoryVerifierCache();
    // Should not throw
    expect(() => cache.evict(capabilityId("nonexistent"))).not.toThrow();
  });

  test("evict removes only entries for the given tokenId", () => {
    const cache = createInMemoryVerifierCache();
    const idA = capabilityId("token-a");
    const idB = capabilityId("token-b");
    const r = { ok: true as const, token: makeHmacToken("token-a") };
    cache.set(idA, "read_file", r);
    cache.set(idB, "read_file", r);

    cache.evict(idA);

    expect(cache.get(idA, "read_file")).toBeUndefined();
    expect(cache.get(idB, "read_file")).toBeDefined(); // B unaffected
  });
});
