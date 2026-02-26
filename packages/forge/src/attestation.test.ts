/**
 * Comprehensive adversarial tests for attestation — creation, signing, verification.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeProvenance, SigningBackend } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createForgeProvenance, signAttestation, verifyAttestation } from "./attestation.js";
import type { ForgeConfig } from "./config.js";
import { createDefaultForgeConfig } from "./config.js";
import type { ForgeContext, ForgeToolInput, VerificationReport } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSigner(): SigningBackend {
  const BLOCK_SIZE = 64;
  const secretKey = new Uint8Array(32).fill(42);

  function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hasher1 = new Bun.CryptoHasher("sha256");
    const paddedKey = new Uint8Array(BLOCK_SIZE);
    paddedKey.set(
      key.length > BLOCK_SIZE
        ? new Uint8Array(new Bun.CryptoHasher("sha256").update(key).digest())
        : key,
    );
    const innerPad = new Uint8Array(BLOCK_SIZE);
    const outerPad = new Uint8Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
      const kb = paddedKey[i] ?? 0;
      innerPad[i] = kb ^ 0x36;
      outerPad[i] = kb ^ 0x5c;
    }
    hasher1.update(innerPad);
    hasher1.update(data);
    const innerDigest = new Uint8Array(hasher1.digest());
    const hasher2 = new Bun.CryptoHasher("sha256");
    hasher2.update(outerPad);
    hasher2.update(innerDigest);
    return new Uint8Array(hasher2.digest());
  }

  return {
    algorithm: "hmac-sha256",
    sign: (data: Uint8Array) => hmac(secretKey, data),
    verify: (data: Uint8Array, signature: Uint8Array) => {
      const expected = hmac(secretKey, data);
      if (expected.length !== signature.length) return false;
      // let justified: accumulator for bitwise comparison
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= (expected[i] ?? 0) ^ (signature[i] ?? 0);
      }
      return diff === 0;
    },
  };
}

function createWrongSigner(): SigningBackend {
  return {
    algorithm: "hmac-sha256",
    sign: (_data: Uint8Array) => new Uint8Array(32).fill(0),
    verify: (_data: Uint8Array, _sig: Uint8Array) => false,
  };
}

const defaultContext: ForgeContext = {
  agentId: "agent-test",
  depth: 0,
  sessionId: "sess-test",
  forgesThisSession: 0,
};

const defaultConfig: ForgeConfig = createDefaultForgeConfig();

const defaultReport: VerificationReport = {
  stages: [
    { stage: "static", passed: true, durationMs: 50 },
    { stage: "sandbox", passed: true, durationMs: 200 },
    { stage: "self_test", passed: true, durationMs: 150 },
    { stage: "trust", passed: true, durationMs: 100 },
  ],
  finalTrustTier: "sandbox",
  totalDurationMs: 500,
  passed: true,
};

const defaultToolInput: ForgeToolInput = {
  kind: "tool",
  name: "test-tool",
  description: "A test tool",
  inputSchema: { type: "object" },
  implementation: 'return "hello";',
};

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("createForgeProvenance", () => {
  test("creates provenance from valid forge pipeline output", () => {
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "abc123",
      invocationId: "inv-001",
      startedAt: 1_000_000,
      finishedAt: 1_001_000,
    });

    expect(provenance.source.origin).toBe("forged");
    expect(provenance.buildDefinition.buildType).toBe("koi.forge/tool/v1");
    expect(provenance.builder.id).toBe("koi.forge/pipeline/v1");
    expect(provenance.metadata.agentId).toBe("agent-test");
    expect(provenance.metadata.sessionId).toBe("sess-test");
    expect(provenance.metadata.depth).toBe(0);
    expect(provenance.verification.passed).toBe(true);
    expect(provenance.verification.stageResults).toHaveLength(4);
    expect(provenance.contentHash).toBe("abc123");
    expect(provenance.attestation).toBeUndefined();
  });

  test("defaults classification to public", () => {
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash",
      invocationId: "inv-002",
      startedAt: 0,
      finishedAt: 1,
    });

    expect(provenance.classification).toBe("public");
    expect(provenance.contentMarkers).toEqual([]);
  });

  test("propagates explicit classification", () => {
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash",
      invocationId: "inv-003",
      startedAt: 0,
      finishedAt: 1,
      classification: "secret",
      contentMarkers: ["credentials", "pii"],
    });

    expect(provenance.classification).toBe("secret");
    expect(provenance.contentMarkers).toEqual(["credentials", "pii"]);
  });

  test("preserves content markers in provenance", () => {
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash",
      invocationId: "inv-004",
      startedAt: 0,
      finishedAt: 1,
      contentMarkers: ["phi", "payment"],
    });

    expect(provenance.contentMarkers).toContain("phi");
    expect(provenance.contentMarkers).toContain("payment");
  });

  test("empty content markers array is valid", () => {
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash",
      invocationId: "inv-005",
      startedAt: 0,
      finishedAt: 1,
      contentMarkers: [],
    });

    expect(provenance.contentMarkers).toEqual([]);
  });

  test("maps external parameters from input", () => {
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash",
      invocationId: "inv-006",
      startedAt: 0,
      finishedAt: 1,
    });

    const params = provenance.buildDefinition.externalParameters;
    expect(params.kind).toBe("tool");
    expect(params.name).toBe("test-tool");
    expect(params.implementation).toBe('return "hello";');
  });
});

// ---------------------------------------------------------------------------
// Sign + verify round-trip
// ---------------------------------------------------------------------------

describe("signAttestation", () => {
  test("signs provenance and populates attestation field", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-001",
      invocationId: "inv-sign-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);

    expect(signed.attestation).toBeDefined();
    expect(signed.attestation?.algorithm).toBe("hmac-sha256");
    expect(signed.attestation?.signature).toBeTruthy();
    expect(signed.attestation?.signature.length).toBeGreaterThan(0);
  });

  test("sign and verify round-trip succeeds", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-002",
      invocationId: "inv-rt-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, signer);

    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("verifyAttestation", () => {
  test("returns false for missing attestation", async () => {
    const signer = createMockSigner();
    const valid = await verifyAttestation(DEFAULT_PROVENANCE, signer);
    expect(valid).toBe(false);
  });

  test("returns false for tampered content hash", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "original-hash",
      invocationId: "inv-tamper-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);

    // Tamper with the content hash
    const tampered: ForgeProvenance = {
      ...signed,
      contentHash: "tampered-hash",
    };

    const valid = await verifyAttestation(tampered, signer);
    expect(valid).toBe(false);
  });

  test("returns false for invalid signature", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-invalid-sig",
      invocationId: "inv-invalid-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);

    // Replace signature with garbage
    const forged: ForgeProvenance = {
      ...signed,
      attestation: {
        algorithm: "hmac-sha256",
        signature: "00".repeat(32),
      },
    };

    const valid = await verifyAttestation(forged, signer);
    expect(valid).toBe(false);
  });

  test("returns false when verified with wrong signer", async () => {
    const signer = createMockSigner();
    const wrongSigner = createWrongSigner();

    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-wrong-key",
      invocationId: "inv-wrong-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, wrongSigner);
    expect(valid).toBe(false);
  });

  test("returns false for tampered agentId", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-tamper-agent",
      invocationId: "inv-tamper-agent-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);

    // Tamper with metadata
    const tampered: ForgeProvenance = {
      ...signed,
      metadata: { ...signed.metadata, agentId: "malicious-agent" },
    };

    const valid = await verifyAttestation(tampered, signer);
    expect(valid).toBe(false);
  });

  test("returns false for tampered classification", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-tamper-class",
      invocationId: "inv-tamper-class-001",
      startedAt: 0,
      finishedAt: 1,
      classification: "secret",
    });

    const signed = await signAttestation(provenance, signer);

    // Tamper: downgrade classification from secret to public
    const tampered: ForgeProvenance = {
      ...signed,
      classification: "public",
    };

    const valid = await verifyAttestation(tampered, signer);
    expect(valid).toBe(false);
  });

  test("returns false for tampered verification summary", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-tamper-verify",
      invocationId: "inv-tamper-verify-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signed = await signAttestation(provenance, signer);

    // Tamper: change trust tier to promoted
    const tampered: ForgeProvenance = {
      ...signed,
      verification: {
        ...signed.verification,
        finalTrustTier: "promoted",
      },
    };

    const valid = await verifyAttestation(tampered, signer);
    expect(valid).toBe(false);
  });

  test("expired/future timestamps still verify (no TTL)", async () => {
    const signer = createMockSigner();
    const provenance = createForgeProvenance({
      input: defaultToolInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-future",
      invocationId: "inv-future-001",
      startedAt: Date.now() + 1_000_000_000, // far future
      finishedAt: Date.now() + 1_000_001_000,
    });

    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, signer);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("attestation edge cases", () => {
  test("very large external parameters (10KB+)", async () => {
    const largeInput: ForgeToolInput = {
      ...defaultToolInput,
      implementation: "x".repeat(10_000),
    };

    const provenance = createForgeProvenance({
      input: largeInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-large",
      invocationId: "inv-large-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signer = createMockSigner();
    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, signer);
    expect(valid).toBe(true);
  });

  test("unicode content in implementation", async () => {
    const unicodeInput: ForgeToolInput = {
      ...defaultToolInput,
      implementation: 'return "Hello 世界! 🎉 Ñoño";',
    };

    const provenance = createForgeProvenance({
      input: unicodeInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-unicode",
      invocationId: "inv-unicode-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signer = createMockSigner();
    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, signer);
    expect(valid).toBe(true);
  });

  test("empty implementation string", async () => {
    const emptyInput: ForgeToolInput = {
      ...defaultToolInput,
      implementation: "",
    };

    const provenance = createForgeProvenance({
      input: emptyInput,
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-empty",
      invocationId: "inv-empty-001",
      startedAt: 0,
      finishedAt: 1,
    });

    const signer = createMockSigner();
    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, signer);
    expect(valid).toBe(true);
  });

  test("provenance for skill kind", () => {
    const provenance = createForgeProvenance({
      input: { kind: "skill", name: "test-skill", description: "A skill", body: "# Skill" },
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-skill",
      invocationId: "inv-skill-001",
      startedAt: 0,
      finishedAt: 1,
    });

    expect(provenance.buildDefinition.buildType).toBe("koi.forge/skill/v1");
  });

  test("provenance for agent kind", () => {
    const provenance = createForgeProvenance({
      input: {
        kind: "agent",
        name: "test-agent",
        description: "An agent",
        manifestYaml: "name: test",
      },
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-agent",
      invocationId: "inv-agent-001",
      startedAt: 0,
      finishedAt: 1,
    });

    expect(provenance.buildDefinition.buildType).toBe("koi.forge/agent/v1");
  });

  test("provenance for middleware kind", () => {
    const provenance = createForgeProvenance({
      input: {
        kind: "middleware",
        name: "test-mw",
        description: "A middleware",
        implementation: "return mw;",
      },
      context: defaultContext,
      report: defaultReport,
      config: defaultConfig,
      contentHash: "hash-mw",
      invocationId: "inv-mw-001",
      startedAt: 0,
      finishedAt: 1,
    });

    expect(provenance.buildDefinition.buildType).toBe("koi.forge/middleware/v1");
  });
});
