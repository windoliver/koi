/**
 * Provenance type shape tests — validates ForgeProvenance and related types.
 *
 * These are compile-time + structural tests. The types themselves are pure
 * interfaces — we test that values conforming to them have the right shape.
 */

import { describe, expect, test } from "bun:test";
import type {
  ContentMarker,
  DataClassification,
  ForgeAttestationSignature,
  ForgeBuildDefinition,
  ForgeBuilder,
  ForgeProvenance,
  ForgeResourceRef,
  ForgeRunMetadata,
  ForgeStageDigest,
  ForgeVerificationSummary,
  SigningBackend,
} from "./provenance.js";

describe("ForgeProvenance", () => {
  const validProvenance: ForgeProvenance = {
    source: { origin: "forged", forgedBy: "agent-1", sessionId: "sess-1" },
    buildDefinition: {
      buildType: "koi.forge/tool/v1",
      externalParameters: { name: "test", kind: "tool" },
    },
    builder: { id: "koi.forge/pipeline/v1" },
    metadata: {
      invocationId: "inv-001",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      sessionId: "sess-1",
      agentId: "agent-1",
      depth: 0,
    },
    verification: {
      passed: true,
      finalTrustTier: "sandbox",
      totalDurationMs: 1000,
      stageResults: [
        { stage: "static", passed: true, durationMs: 100 },
        { stage: "sandbox", passed: true, durationMs: 400 },
        { stage: "self_test", passed: true, durationMs: 300 },
        { stage: "trust", passed: true, durationMs: 200 },
      ],
    },
    classification: "public",
    contentMarkers: [],
    contentHash: "abc123",
  };

  test("has all required fields present", () => {
    expect(validProvenance.source).toBeDefined();
    expect(validProvenance.buildDefinition).toBeDefined();
    expect(validProvenance.builder).toBeDefined();
    expect(validProvenance.metadata).toBeDefined();
    expect(validProvenance.verification).toBeDefined();
    expect(validProvenance.classification).toBeDefined();
    expect(validProvenance.contentMarkers).toBeDefined();
    expect(validProvenance.contentHash).toBeDefined();
  });

  test("attestation is optional", () => {
    expect(validProvenance.attestation).toBeUndefined();

    const withAttestation: ForgeProvenance = {
      ...validProvenance,
      attestation: {
        algorithm: "hmac-sha256",
        signature: "deadbeef",
      },
    };
    expect(withAttestation.attestation?.algorithm).toBe("hmac-sha256");
    expect(withAttestation.attestation?.signature).toBe("deadbeef");
  });

  test("attestation supports optional keyId", () => {
    const withKeyId: ForgeAttestationSignature = {
      algorithm: "ed25519",
      signature: "cafebabe",
      keyId: "key-rotation-2024",
    };
    expect(withKeyId.keyId).toBe("key-rotation-2024");
  });
});

describe("DataClassification", () => {
  test("supports all three values", () => {
    const values: DataClassification[] = ["public", "internal", "secret"];
    expect(values).toHaveLength(3);
    expect(values).toContain("public");
    expect(values).toContain("internal");
    expect(values).toContain("secret");
  });
});

describe("ContentMarker", () => {
  test("supports all four values", () => {
    const values: ContentMarker[] = ["credentials", "pii", "phi", "payment"];
    expect(values).toHaveLength(4);
    expect(values).toContain("credentials");
    expect(values).toContain("pii");
    expect(values).toContain("phi");
    expect(values).toContain("payment");
  });
});

describe("ForgeProvenance with BrickSource composition", () => {
  test("works with forged source", () => {
    const provenance: ForgeProvenance = {
      source: { origin: "forged", forgedBy: "agent-1", sessionId: "sess-1" },
      buildDefinition: { buildType: "koi.forge/tool/v1", externalParameters: {} },
      builder: { id: "koi.forge/pipeline/v1" },
      metadata: {
        invocationId: "inv-1",
        startedAt: 0,
        finishedAt: 1,
        sessionId: "s",
        agentId: "a",
        depth: 0,
      },
      verification: {
        passed: true,
        finalTrustTier: "sandbox",
        totalDurationMs: 1,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: "hash",
    };
    expect(provenance.source.origin).toBe("forged");
  });

  test("works with bundled source", () => {
    const provenance: ForgeProvenance = {
      source: { origin: "bundled", bundleName: "stdlib", bundleVersion: "1.0.0" },
      buildDefinition: { buildType: "koi.forge/skill/v1", externalParameters: {} },
      builder: { id: "koi.forge/pipeline/v1" },
      metadata: {
        invocationId: "inv-2",
        startedAt: 0,
        finishedAt: 1,
        sessionId: "s",
        agentId: "a",
        depth: 0,
      },
      verification: {
        passed: true,
        finalTrustTier: "verified",
        totalDurationMs: 1,
        stageResults: [],
      },
      classification: "internal",
      contentMarkers: [],
      contentHash: "hash",
    };
    expect(provenance.source.origin).toBe("bundled");
  });

  test("works with external source", () => {
    const provenance: ForgeProvenance = {
      source: { origin: "external", registry: "npm", packageRef: "@org/tool@1.0.0" },
      buildDefinition: { buildType: "koi.forge/agent/v1", externalParameters: {} },
      builder: { id: "koi.forge/pipeline/v1" },
      metadata: {
        invocationId: "inv-3",
        startedAt: 0,
        finishedAt: 1,
        sessionId: "s",
        agentId: "a",
        depth: 0,
      },
      verification: {
        passed: true,
        finalTrustTier: "promoted",
        totalDurationMs: 1,
        stageResults: [],
      },
      classification: "secret",
      contentMarkers: ["credentials"],
      contentHash: "hash",
    };
    expect(provenance.source.origin).toBe("external");
    expect(provenance.classification).toBe("secret");
    expect(provenance.contentMarkers).toContain("credentials");
  });
});

describe("ForgeVerificationSummary", () => {
  test("contains stage digests for 4-stage pipeline", () => {
    const summary: ForgeVerificationSummary = {
      passed: true,
      finalTrustTier: "sandbox",
      totalDurationMs: 1000,
      stageResults: [
        { stage: "static", passed: true, durationMs: 100 },
        { stage: "sandbox", passed: true, durationMs: 400 },
        { stage: "self_test", passed: true, durationMs: 300 },
        { stage: "trust", passed: true, durationMs: 200 },
      ],
    };
    expect(summary.stageResults).toHaveLength(4);
    expect(summary.stageResults.every((s) => s.passed)).toBe(true);
  });

  test("stage digest has required fields", () => {
    const digest: ForgeStageDigest = {
      stage: "sandbox",
      passed: false,
      durationMs: 500,
    };
    expect(digest.stage).toBe("sandbox");
    expect(digest.passed).toBe(false);
    expect(digest.durationMs).toBe(500);
  });
});

describe("ForgeBuildDefinition", () => {
  test("supports resolved dependencies", () => {
    const def: ForgeBuildDefinition = {
      buildType: "koi.forge/tool/v1",
      externalParameters: {},
      resolvedDependencies: [
        { uri: "brick://math-utils", digest: { sha256: "abc" }, name: "math-utils" },
        { uri: "brick://string-helpers" },
      ],
    };
    expect(def.resolvedDependencies).toHaveLength(2);
  });

  test("supports internal parameters", () => {
    const def: ForgeBuildDefinition = {
      buildType: "koi.forge/tool/v1",
      externalParameters: {},
      internalParameters: { sandboxTimeout: 5000, maxRetries: 3 },
    };
    expect(def.internalParameters?.sandboxTimeout).toBe(5000);
  });
});

describe("ForgeResourceRef", () => {
  test("minimal resource ref has only uri", () => {
    const ref: ForgeResourceRef = { uri: "brick://tool-1" };
    expect(ref.uri).toBe("brick://tool-1");
    expect(ref.digest).toBeUndefined();
    expect(ref.name).toBeUndefined();
  });
});

describe("ForgeBuilder", () => {
  test("supports optional version and nodeId", () => {
    const builder: ForgeBuilder = {
      id: "koi.forge/pipeline/v1",
      version: "2.1.0",
      nodeId: "node-east-1",
    };
    expect(builder.version).toBe("2.1.0");
    expect(builder.nodeId).toBe("node-east-1");
  });
});

describe("ForgeRunMetadata", () => {
  test("contains all timing and context fields", () => {
    const metadata: ForgeRunMetadata = {
      invocationId: "inv-uuid",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_005_000,
      sessionId: "sess-abc",
      agentId: "agent-x",
      depth: 2,
    };
    expect(metadata.finishedAt - metadata.startedAt).toBe(5000);
    expect(metadata.depth).toBe(2);
  });
});

describe("SigningBackend", () => {
  test("interface shape is correct", () => {
    const mockBackend: SigningBackend = {
      algorithm: "hmac-sha256",
      sign: (_data: Uint8Array) => new Uint8Array(32),
      verify: (_data: Uint8Array, _sig: Uint8Array) => true,
    };
    expect(mockBackend.algorithm).toBe("hmac-sha256");
    expect(typeof mockBackend.sign).toBe("function");
    expect(typeof mockBackend.verify).toBe("function");
  });

  test("supports async sign/verify", async () => {
    const asyncBackend: SigningBackend = {
      algorithm: "ed25519",
      sign: async (_data: Uint8Array) => Promise.resolve(new Uint8Array(64)),
      verify: async (_data: Uint8Array, _sig: Uint8Array) => Promise.resolve(true),
    };
    const sig = await asyncBackend.sign(new Uint8Array(10));
    expect(sig).toBeInstanceOf(Uint8Array);
    const valid = await asyncBackend.verify(new Uint8Array(10), sig);
    expect(valid).toBe(true);
  });
});
