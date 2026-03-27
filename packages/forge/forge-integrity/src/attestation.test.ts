/**
 * Tests for canonicalJsonSerialize, createForgeProvenance, signAttestation, verifyAttestation.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeProvenance, SigningBackend } from "@koi/core";
import type {
  ForgeContext,
  ForgeInput,
  ForgeToolInput,
  VerificationReport,
} from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import type { CreateProvenanceOptions } from "./attestation.js";
import {
  canonicalJsonSerialize,
  createForgeProvenance,
  signAttestation,
  verifyAttestation,
} from "./attestation.js";

// ---------------------------------------------------------------------------
// HMAC-SHA256 test signer
// ---------------------------------------------------------------------------

const TEST_SECRET = new TextEncoder().encode("test-signing-secret");

function createTestSigner(): SigningBackend {
  return {
    algorithm: "hmac-sha256",
    sign(data: Uint8Array): Uint8Array {
      const hasher = new Bun.CryptoHasher("sha256", TEST_SECRET);
      hasher.update(data);
      return new Uint8Array(hasher.digest());
    },
    verify(data: Uint8Array, signature: Uint8Array): boolean {
      const hasher = new Bun.CryptoHasher("sha256", TEST_SECRET);
      hasher.update(data);
      const expected = new Uint8Array(hasher.digest());
      if (expected.length !== signature.length) return false;
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== signature[i]) return false;
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — minimal forge provenance options
// ---------------------------------------------------------------------------

function createTestInput(overrides?: Partial<ForgeToolInput>): ForgeInput {
  return {
    kind: "tool" as const,
    name: "test-tool",
    description: "A test tool",
    tags: ["test"],
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<ForgeContext>): ForgeContext {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    depth: 0,
    forgesThisSession: 0,
    ...overrides,
  };
}

function createTestReport(overrides?: Partial<VerificationReport>): VerificationReport {
  return {
    passed: true,
    sandbox: true,
    totalDurationMs: 500,
    stages: [
      { stage: "static", passed: true, durationMs: 100 },
      { stage: "sandbox", passed: true, durationMs: 200 },
      { stage: "self_test", passed: true, durationMs: 100 },
      { stage: "trust", passed: true, durationMs: 100 },
    ],
    ...overrides,
  };
}

function createTestOptions(overrides?: Partial<CreateProvenanceOptions>): CreateProvenanceOptions {
  return {
    input: createTestInput(),
    context: createTestContext(),
    report: createTestReport(),
    config: createDefaultForgeConfig(),
    contentHash: "sha256:abc123",
    invocationId: "inv-001",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalJsonSerialize
// ---------------------------------------------------------------------------

describe("canonicalJsonSerialize", () => {
  test("sorted keys deterministic", () => {
    const result1 = canonicalJsonSerialize({ b: 2, a: 1, c: 3 });
    const result2 = canonicalJsonSerialize({ c: 3, a: 1, b: 2 });
    expect(result1).toBe(result2);
    expect(result1).toBe('{"a":1,"b":2,"c":3}');
  });

  test("same input always same output", () => {
    const input = { name: "test", value: 42, nested: { x: 1 } };
    const first = canonicalJsonSerialize(input);
    const second = canonicalJsonSerialize(input);
    const third = canonicalJsonSerialize(input);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test("handles nested objects, arrays, null, undefined", () => {
    const input = {
      nested: { z: 1, a: 2 },
      arr: [3, "hello", null],
      nothing: null,
      missing: undefined,
    };
    const result = canonicalJsonSerialize(input);

    // undefined values are stripped from objects
    expect(result).not.toContain("missing");

    // null is serialized as "null"
    expect(result).toContain("null");

    // nested objects have sorted keys
    expect(result).toContain('"nested":{"a":2,"z":1}');

    // arrays preserve order
    expect(result).toContain('"arr":[3,"hello",null]');
  });

  test("undefined at top level serializes to null", () => {
    expect(canonicalJsonSerialize(undefined)).toBe("null");
  });

  test("primitives serialize correctly", () => {
    expect(canonicalJsonSerialize(42)).toBe("42");
    expect(canonicalJsonSerialize("hello")).toBe('"hello"');
    expect(canonicalJsonSerialize(true)).toBe("true");
    expect(canonicalJsonSerialize(null)).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// createForgeProvenance
// ---------------------------------------------------------------------------

describe("createForgeProvenance", () => {
  test("creates valid provenance with all fields", () => {
    const options = createTestOptions();
    const provenance = createForgeProvenance(options);

    expect(provenance.source.origin).toBe("forged");
    if (provenance.source.origin === "forged") {
      expect(provenance.source.forgedBy).toBe("agent-1");
      expect(provenance.source.sessionId).toBe("session-1");
    }
    expect(provenance.buildDefinition.buildType).toBe("koi.forge/tool/v1");
    expect(provenance.builder.id).toBe("koi.forge/pipeline/v1");
    expect(provenance.metadata.invocationId).toBe("inv-001");
    expect(provenance.metadata.startedAt).toBe(1_700_000_000_000);
    expect(provenance.metadata.finishedAt).toBe(1_700_000_001_000);
    expect(provenance.metadata.sessionId).toBe("session-1");
    expect(provenance.metadata.agentId).toBe("agent-1");
    expect(provenance.metadata.depth).toBe(0);
    expect(provenance.contentHash).toBe("sha256:abc123");
    expect(provenance.classification).toBe("public");
    expect(provenance.contentMarkers).toEqual([]);
  });

  test("maps verification report correctly", () => {
    const report = createTestReport({
      passed: true,
      sandbox: true,
      totalDurationMs: 750,
      stages: [
        { stage: "static", passed: true, durationMs: 250 },
        { stage: "sandbox", passed: true, durationMs: 500 },
      ],
    });
    const options = createTestOptions({ report });
    const provenance = createForgeProvenance(options);

    expect(provenance.verification.passed).toBe(true);
    expect(provenance.verification.sandbox).toBe(true);
    expect(provenance.verification.totalDurationMs).toBe(750);
    expect(provenance.verification.stageResults).toEqual([
      { stage: "static", passed: true, durationMs: 250 },
      { stage: "sandbox", passed: true, durationMs: 500 },
    ]);
  });

  test("maps resolved dependencies from requires.packages", () => {
    const input = createTestInput({
      requires: {
        packages: { lodash: "4.17.21", zod: "3.22.0" },
      },
    });
    const options = createTestOptions({ input });
    const provenance = createForgeProvenance(options);

    expect(provenance.buildDefinition.resolvedDependencies).toBeDefined();
    const deps = provenance.buildDefinition.resolvedDependencies;
    expect(deps).toHaveLength(2);

    const uris = deps?.map((d) => d.uri).sort();
    expect(uris).toEqual(["npm:lodash@4.17.21", "npm:zod@3.22.0"]);

    const names = deps?.map((d) => d.name).sort();
    expect(names).toEqual(["lodash", "zod"]);
  });

  test("handles empty/missing optional fields", () => {
    const input = createTestInput();
    const options = createTestOptions({ input });
    const provenance = createForgeProvenance(options);

    // No requires.packages → no resolvedDependencies
    expect(provenance.buildDefinition.resolvedDependencies).toBeUndefined();

    // Defaults to "public" classification and empty content markers
    expect(provenance.classification).toBe("public");
    expect(provenance.contentMarkers).toEqual([]);

    // No attestation field by default
    expect(provenance.attestation).toBeUndefined();
  });

  test("maps custom classification and content markers", () => {
    const options = createTestOptions({
      classification: "internal",
      contentMarkers: ["pii", "payment"],
    });
    const provenance = createForgeProvenance(options);

    expect(provenance.classification).toBe("internal");
    expect(provenance.contentMarkers).toEqual(["pii", "payment"]);
  });
});

// ---------------------------------------------------------------------------
// signAttestation
// ---------------------------------------------------------------------------

describe("signAttestation", () => {
  test("produces provenance with attestation field", async () => {
    const signer = createTestSigner();
    const options = createTestOptions();
    const provenance = createForgeProvenance(options);

    const signed = await signAttestation(provenance, signer);

    expect(signed.attestation).toBeDefined();
    expect(signed.attestation?.algorithm).toBe("hmac-sha256");
    expect(signed.attestation?.signature).toMatch(/^[0-9a-f]+$/);
    // Original fields preserved
    expect(signed.contentHash).toBe(provenance.contentHash);
    expect(signed.source).toEqual(provenance.source);
  });
});

// ---------------------------------------------------------------------------
// signAttestation → verifyAttestation round-trip
// ---------------------------------------------------------------------------

describe("signAttestation + verifyAttestation", () => {
  test("round-trip succeeds", async () => {
    const signer = createTestSigner();
    const options = createTestOptions();
    const provenance = createForgeProvenance(options);

    const signed = await signAttestation(provenance, signer);
    const valid = await verifyAttestation(signed, signer);

    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyAttestation
// ---------------------------------------------------------------------------

describe("verifyAttestation", () => {
  test("returns false for unsigned provenance", async () => {
    const signer = createTestSigner();
    const options = createTestOptions();
    const provenance = createForgeProvenance(options);

    // No attestation field
    const valid = await verifyAttestation(provenance, signer);
    expect(valid).toBe(false);
  });

  test("returns false for tampered canonical JSON", async () => {
    const signer = createTestSigner();
    const options = createTestOptions();
    const provenance = createForgeProvenance(options);

    const signed = await signAttestation(provenance, signer);

    // Tamper with content hash after signing
    const tampered: ForgeProvenance = {
      ...signed,
      contentHash: "sha256:tampered",
    };

    const valid = await verifyAttestation(tampered, signer);
    expect(valid).toBe(false);
  });
});
