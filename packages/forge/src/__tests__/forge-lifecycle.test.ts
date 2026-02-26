/**
 * E2E lifecycle test — forge → store → verify → runtime resolution.
 *
 * Exercises the full provenance pipeline: signing, integrity verification,
 * attestation verification, SLSA serialization, and runtime resolution.
 */

import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, SigningBackend, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createForgeRuntime } from "../forge-runtime.js";
import { verifyBrickAttestation, verifyBrickIntegrity } from "../integrity.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { mapProvenanceToStatement } from "../slsa-serializer.js";
import { createForgeToolTool } from "../tools/forge-tool.js";
import type { ForgeDeps } from "../tools/shared.js";
import type { ForgeResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
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

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

function mockTiered(): TieredSandboxExecutor {
  const e = mockExecutor();
  return {
    forTier: (tier) => ({
      executor: e,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// E2E test
// ---------------------------------------------------------------------------

describe("forge lifecycle with provenance", () => {
  test("forge → sign → verify → serialize → runtime resolve → tamper → reject", async () => {
    // 1. Create signer, store, and deps
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();
    const deps: ForgeDeps = {
      store,
      executor: mockTiered(),
      verifiers: [],
      config: createDefaultForgeConfig(),
      context: {
        agentId: "lifecycle-agent",
        depth: 0,
        sessionId: "lifecycle-session",
        forgesThisSession: 0,
      },
      signer,
    };

    // 2. Execute forge pipeline for a tool
    const forgeTool = createForgeToolTool(deps);
    const forgeResult = (await forgeTool.execute({
      name: "lifecycle-adder",
      description: "Adds two numbers",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      implementation: "return input.a + input.b;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    const { id } = forgeResult.value;
    expect(id).toMatch(/^sha256:/);

    // 3. Verify stored artifact has signed provenance
    const loadResult = await store.load(id);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const brick = loadResult.value;
    expect(brick.provenance.attestation).toBeDefined();
    expect(brick.provenance.attestation?.algorithm).toBe("hmac-sha256");
    expect(brick.provenance.attestation?.signature.length).toBeGreaterThan(0);

    // 4. Verify content integrity passes
    const integrityResult = verifyBrickIntegrity(brick);
    expect(integrityResult.ok).toBe(true);
    expect(integrityResult.kind).toBe("ok");

    // 5. Verify attestation passes
    const attestResult = await verifyBrickAttestation(brick, signer);
    expect(attestResult.ok).toBe(true);
    expect(attestResult.kind).toBe("ok");

    // 6. Verify SLSA Statement envelope is valid
    const statement = mapProvenanceToStatement(brick.provenance, id);
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject).toHaveLength(1);
    expect(statement.subject[0]?.name).toBe(id);
    expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(statement.predicate.koi_classification).toBe("public");
    expect(statement.predicate.koi_contentMarkers).toEqual([]);
    expect(statement.predicate.koi_verification.passed).toBe(true);

    // 7. Create ForgeRuntime with same signer — resolveTool succeeds
    const runtime = createForgeRuntime({ store, executor: mockTiered(), signer });
    const resolved = await runtime.resolveTool("lifecycle-adder");
    expect(resolved).toBeDefined();
    expect(resolved?.descriptor.name).toBe("lifecycle-adder");

    // 8. Tamper with stored artifact → resolveTool rejects
    const tamperedBrick = { ...brick, implementation: "return 'EVIL';" };
    await store.save(tamperedBrick);

    // Wait for cache invalidation
    await new Promise((r) => setTimeout(r, 10));

    const rejected = await runtime.resolveTool("lifecycle-adder");
    expect(rejected).toBeUndefined();

    // Clean up
    runtime.dispose?.();
  });
});
