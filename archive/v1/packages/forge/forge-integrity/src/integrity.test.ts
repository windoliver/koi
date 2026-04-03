/**
 * Tests for verifyBrickIntegrity, verifyBrickAttestation, loadAndVerify.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  BrickId,
  ForgeProvenance,
  ForgeStore,
  KoiError,
  Result,
  SigningBackend,
} from "@koi/core";
import { brickId } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import {
  createTestAgentArtifact,
  createTestCompositeArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
  DEFAULT_PROVENANCE,
} from "@koi/test-utils";
import { signAttestation } from "./attestation.js";
import { loadAndVerify, verifyBrickAttestation, verifyBrickIntegrity } from "./integrity.js";

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
// Mock ForgeStore
// ---------------------------------------------------------------------------

function createMockStore(bricks: readonly BrickArtifact[]): ForgeStore {
  const brickMap = new Map<string, BrickArtifact>();
  for (const brick of bricks) {
    brickMap.set(brick.id, brick);
  }

  return {
    save: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    load: mock(async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const brick = brickMap.get(id);
      if (brick === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Brick ${id} not found`, retryable: false },
        };
      }
      return { ok: true, value: brick };
    }),
    search: mock(
      async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
        ok: true,
        value: [],
      }),
    ),
    remove: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    update: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    exists: mock(async (): Promise<Result<boolean, KoiError>> => ({ ok: true, value: false })),
  };
}

// ---------------------------------------------------------------------------
// verifyBrickIntegrity
// ---------------------------------------------------------------------------

describe("verifyBrickIntegrity", () => {
  test("ok for valid tool brick (content hash matches)", () => {
    const content = "return 1;";
    const correctId = computeBrickId("tool", content);
    const tool = createTestToolArtifact({ id: correctId, implementation: content });

    const result = verifyBrickIntegrity(tool);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("content_mismatch when implementation tampered", () => {
    const content = "return 1;";
    const correctId = computeBrickId("tool", content);
    // Create with correct id but different implementation
    const tool = createTestToolArtifact({ id: correctId, implementation: "return 999;" });

    const result = verifyBrickIntegrity(tool);
    expect(result.kind).toBe("content_mismatch");
    expect(result.ok).toBe(false);
    if (result.kind === "content_mismatch") {
      expect(result.expectedId).toBe(correctId);
      expect(result.actualId).not.toBe(correctId);
    }
  });

  test("ok for skill brick", () => {
    const content = "# Test Skill";
    const correctId = computeBrickId("skill", content);
    const skill = createTestSkillArtifact({ id: correctId, content });

    const result = verifyBrickIntegrity(skill);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("ok for agent brick", () => {
    const manifestYaml = "name: test-agent\ntype: assistant";
    const correctId = computeBrickId("agent", manifestYaml);
    const agent = createTestAgentArtifact({ id: correctId, manifestYaml });

    const result = verifyBrickIntegrity(agent);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("ok for composite brick", () => {
    const composite = createTestCompositeArtifact();
    // Compute the expected ID from composite step brickIds joined
    const stepContent = composite.steps.map((s) => s.brickId).join(",");
    const correctId = computeBrickId("composite", stepContent);
    const validComposite = createTestCompositeArtifact({ id: correctId });

    const result = verifyBrickIntegrity(validComposite);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyBrickAttestation
// ---------------------------------------------------------------------------

describe("verifyBrickAttestation", () => {
  test("ok for signed + valid content", async () => {
    const signer = createTestSigner();
    const content = "return 42;";
    const correctId = computeBrickId("tool", content);

    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      contentHash: correctId,
    };

    const signedProvenance = await signAttestation(provenance, signer);
    const tool = createTestToolArtifact({
      id: correctId,
      implementation: content,
      provenance: signedProvenance,
    });

    const result = await verifyBrickAttestation(tool, signer);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("content_mismatch even with valid signature", async () => {
    const signer = createTestSigner();
    const originalContent = "return 42;";
    const correctId = computeBrickId("tool", originalContent);

    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      contentHash: correctId,
    };

    const signedProvenance = await signAttestation(provenance, signer);
    // Create brick with correct id but tampered implementation
    const tool = createTestToolArtifact({
      id: correctId,
      implementation: "return 999;",
      provenance: signedProvenance,
    });

    const result = await verifyBrickAttestation(tool, signer);
    // Content hash check runs first and fails
    expect(result.kind).toBe("content_mismatch");
    expect(result.ok).toBe(false);
  });

  test("attestation_failed for invalid signature", async () => {
    const signer = createTestSigner();
    const content = "return 42;";
    const correctId = computeBrickId("tool", content);

    // Create a provenance with a bogus attestation
    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      contentHash: correctId,
      attestation: {
        algorithm: "hmac-sha256",
        signature: "deadbeef".repeat(8),
      },
    };

    const tool = createTestToolArtifact({
      id: correctId,
      implementation: content,
      provenance,
    });

    const result = await verifyBrickAttestation(tool, signer);
    expect(result.kind).toBe("attestation_failed");
    expect(result.ok).toBe(false);
    if (result.kind === "attestation_failed") {
      expect(result.reason).toBe("invalid");
    }
  });

  test("ok when no attestation (skips sig check)", async () => {
    const signer = createTestSigner();
    const content = "return 42;";
    const correctId = computeBrickId("tool", content);

    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      contentHash: correctId,
    };

    const tool = createTestToolArtifact({
      id: correctId,
      implementation: content,
      provenance,
    });

    const result = await verifyBrickAttestation(tool, signer);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAndVerify
// ---------------------------------------------------------------------------

describe("loadAndVerify", () => {
  test("returns brick + ok integrity", async () => {
    const content = "return 1;";
    const correctId = computeBrickId("tool", content);
    const tool = createTestToolArtifact({ id: correctId, implementation: content });
    const store = createMockStore([tool]);

    const result = await loadAndVerify(store, correctId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe(correctId);
      expect(result.value.integrity.kind).toBe("ok");
      expect(result.value.integrity.ok).toBe(true);
    }
  });

  test("returns ForgeError for missing brick", async () => {
    const store = createMockStore([]);
    const missingId = brickId(
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );

    const result = await loadAndVerify(store, missingId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("store");
      expect(result.error.code).toBe("LOAD_FAILED");
    }
  });
});
