import { describe, expect, test } from "bun:test";
import type { SigningBackend } from "@koi/core";
import { brickId } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { signAttestation } from "./attestation.js";
import { loadAndVerify, verifyBrickAttestation, verifyBrickIntegrity } from "./integrity.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { AgentArtifact, SkillArtifact, ToolArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — create bricks with content-addressed ids (id IS the hash)
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  const implementation = overrides?.implementation ?? "return 1;";
  const files = overrides?.files;
  const id = overrides?.id ?? computeBrickId("tool", implementation, files);
  return {
    id,
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
    ...overrides,
    // Recompute id if overrides changed content but not id
    ...(overrides !== undefined && overrides.id === undefined
      ? {
          id: computeBrickId(
            "tool",
            overrides.implementation ?? implementation,
            overrides.files ?? files,
          ),
        }
      : {}),
  };
}

function createSkillBrick(overrides?: Partial<SkillArtifact>): SkillArtifact {
  const content = overrides?.content ?? "# Test Skill\nDo something useful.";
  const files = overrides?.files;
  const id = overrides?.id ?? computeBrickId("skill", content, files);
  return {
    id,
    kind: "skill",
    name: "test-skill",
    description: "A test skill",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    content,
    ...overrides,
    ...(overrides !== undefined && overrides.id === undefined
      ? { id: computeBrickId("skill", overrides.content ?? content, overrides.files ?? files) }
      : {}),
  };
}

function createAgentBrick(overrides?: Partial<AgentArtifact>): AgentArtifact {
  const manifestYaml = overrides?.manifestYaml ?? "name: test-agent\nmodel: gpt-4";
  const files = overrides?.files;
  const id = overrides?.id ?? computeBrickId("agent", manifestYaml, files);
  return {
    id,
    kind: "agent",
    name: "test-agent",
    description: "A test agent",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    manifestYaml,
    ...overrides,
    ...(overrides !== undefined && overrides.id === undefined
      ? {
          id: computeBrickId(
            "agent",
            overrides.manifestYaml ?? manifestYaml,
            overrides.files ?? files,
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// verifyBrickIntegrity
// ---------------------------------------------------------------------------

describe("verifyBrickIntegrity", () => {
  test("returns ok for tool with matching id", () => {
    const brick = createToolBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brickId).toBe(brick.id);
      expect(result.id).toBe(brick.id);
    }
  });

  test("returns ok for skill with matching id", () => {
    const brick = createSkillBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("returns ok for agent with matching id", () => {
    const brick = createAgentBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("detects tampered tool implementation", async () => {
    const brick = createToolBrick();
    // Tamper: modify implementation without updating id
    const tampered: ToolArtifact = { ...brick, implementation: "return 'HACKED';" };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
    if (result.kind === "content_mismatch") {
      expect(result.expectedId).toBe(brick.id);
      expect(result.actualId).not.toBe(brick.id);
    }
  });

  test("detects tampered skill content", () => {
    const brick = createSkillBrick();
    const tampered: SkillArtifact = { ...brick, content: "# Malicious content" };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered agent manifestYaml", () => {
    const brick = createAgentBrick();
    const tampered: AgentArtifact = { ...brick, manifestYaml: "name: evil-agent" };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered files", async () => {
    const brick = createToolBrick({ files: { "helper.ts": "export const x = 1;" } });
    const tampered: ToolArtifact = {
      ...brick,
      files: { "helper.ts": "export const x = 'EVIL';" },
    };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("handles brick with no files", () => {
    const brick = createToolBrick();
    expect(brick.files).toBeUndefined();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAndVerify
// ---------------------------------------------------------------------------

describe("loadAndVerify", () => {
  test("returns brick + passing integrity for valid brick", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick();
    await store.save(brick);

    const result = await loadAndVerify(store, brick.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe(brick.id);
      expect(result.value.integrity.ok).toBe(true);
    }
  });

  test("returns brick + failing integrity for tampered brick", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick();
    await store.save(brick);

    // Tamper the brick in the store directly (keeping same id, changing content)
    const tampered: ToolArtifact = { ...brick, implementation: "return 'HACKED';" };
    await store.save(tampered);

    const result = await loadAndVerify(store, brick.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe(brick.id);
      expect(result.value.integrity.ok).toBe(false);
    }
  });

  test("returns ForgeError when brick not found", async () => {
    const store = createInMemoryForgeStore();

    const result = await loadAndVerify(store, brickId("nonexistent"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("store");
      expect(result.error.code).toBe("LOAD_FAILED");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyBrickAttestation
// ---------------------------------------------------------------------------

function createTestSigner(): SigningBackend {
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
      // let justified: accumulator for constant-time comparison
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= (expected[i] ?? 0) ^ (signature[i] ?? 0);
      }
      return diff === 0;
    },
  };
}

describe("verifyBrickAttestation", () => {
  test("valid hash + valid attestation returns IntegrityOk", async () => {
    const signer = createTestSigner();
    const brick = createToolBrick();
    const signedProvenance = await signAttestation(brick.provenance, signer);
    const signedBrick: ToolArtifact = { ...brick, provenance: signedProvenance };

    const result = await verifyBrickAttestation(signedBrick, signer);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ok");
  });

  test("valid hash + invalid attestation returns IntegrityAttestationFailed", async () => {
    const signer = createTestSigner();
    const brick = createToolBrick();
    const badProvenance = {
      ...brick.provenance,
      attestation: { algorithm: "hmac-sha256", signature: "0".repeat(64) },
    };
    const badBrick: ToolArtifact = { ...brick, provenance: badProvenance };

    const result = await verifyBrickAttestation(badBrick, signer);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("attestation_failed");
    if (result.kind === "attestation_failed") {
      expect(result.reason).toBe("invalid");
    }
  });

  test("invalid hash + valid attestation returns IntegrityContentMismatch", async () => {
    const signer = createTestSigner();
    const brick = createToolBrick();
    const signedProvenance = await signAttestation(brick.provenance, signer);
    // Tamper the implementation but keep the signed provenance
    const tamperedBrick: ToolArtifact = {
      ...brick,
      implementation: "return 'HACKED';",
      provenance: signedProvenance,
    };

    const result = await verifyBrickAttestation(tamperedBrick, signer);
    expect(result.ok).toBe(false);
    // Hash check fails first — content_mismatch takes precedence
    expect(result.kind).toBe("content_mismatch");
  });

  test("valid hash + missing attestation returns IntegrityOk (attestation is optional)", async () => {
    const signer = createTestSigner();
    const brick = createToolBrick();
    // No attestation on provenance

    const result = await verifyBrickAttestation(brick, signer);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ok");
  });

  test("valid hash + no signer context handled by caller — function requires signer", async () => {
    // verifyBrickAttestation requires a signer parameter, so this tests
    // that even with a signer, bricks without attestation still pass
    const signer = createTestSigner();
    const brick = createSkillBrick();

    const result = await verifyBrickAttestation(brick, signer);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ok");
  });
});
