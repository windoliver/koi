/**
 * Unit tests for createForgeRuntime factory.
 */

import { describe, expect, mock, test } from "bun:test";
import type { SigningBackend, ToolArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { signAttestation } from "./attestation.js";
import { createForgeRuntime } from "./forge-runtime.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { SandboxExecutor, TieredSandboxExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testToolArtifact(overrides?: Partial<ToolArtifact>): ToolArtifact {
  const implementation = overrides?.implementation ?? "return input;";
  const id = overrides?.id ?? computeBrickId("tool", implementation, overrides?.files);
  return {
    id,
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
    ...overrides,
    // Recompute id if overrides changed content but not id
    ...(overrides !== undefined && overrides.id === undefined
      ? {
          id: computeBrickId("tool", overrides.implementation ?? implementation, overrides.files),
        }
      : {}),
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

function mockTiered(exec?: SandboxExecutor): TieredSandboxExecutor {
  const e = exec ?? mockExecutor();
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
// Tests
// ---------------------------------------------------------------------------

describe("createForgeRuntime", () => {
  test("resolveTool returns Tool for active tool in store", async () => {
    const store = createInMemoryForgeStore();
    const brick = testToolArtifact({ name: "adder" });
    await store.save(brick);

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const tool = await runtime.resolveTool("adder");

    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("adder");
  });

  test("resolveTool returns undefined for non-existent tool", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    const tool = await runtime.resolveTool("nonexistent");
    expect(tool).toBeUndefined();
  });

  test("resolveTool returns undefined for inactive (draft) tool", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "draft-tool", lifecycle: "draft" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const tool = await runtime.resolveTool("draft-tool");

    expect(tool).toBeUndefined();
  });

  test("toolDescriptors returns descriptors for all active tools", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ id: brickId("t1"), name: "tool-a" }));
    await store.save(testToolArtifact({ id: brickId("t2"), name: "tool-b" }));
    await store.save(
      testToolArtifact({ id: brickId("t3"), name: "draft-tool", lifecycle: "draft" }),
    );

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const descriptors = await runtime.toolDescriptors();

    expect(descriptors).toHaveLength(2);
    const names = descriptors.map((d) => d.name);
    expect(names).toContain("tool-a");
    expect(names).toContain("tool-b");
  });

  test("toolDescriptors returns empty array when store is empty", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    const descriptors = await runtime.toolDescriptors();
    expect(descriptors).toHaveLength(0);
  });

  test("cache invalidation: forge new tool → watch → resolveTool finds it", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // Initially no tools
    const before = await runtime.resolveTool("new-tool");
    expect(before).toBeUndefined();

    // Save a new tool to the store
    await store.save(testToolArtifact({ name: "new-tool" }));

    // Events fire immediately — flush microtasks
    await new Promise((r) => setTimeout(r, 10));

    // After watch fires, cache should be invalidated
    const after = await runtime.resolveTool("new-tool");
    expect(after).toBeDefined();
    expect(after?.descriptor.name).toBe("new-tool");
  });

  test("watch propagates typed events from store", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    expect(runtime.watch).toBeDefined();

    const listener = mock(() => {});
    const unsub = runtime.watch?.(listener);

    await store.save(testToolArtifact());
    await new Promise((r) => setTimeout(r, 10));

    expect(listener).toHaveBeenCalledTimes(1);
    // Verify typed event payload
    const calls = listener.mock.calls as unknown as import("@koi/core").StoreChangeEvent[][];
    const event = calls[0]?.[0];
    expect(event).toBeDefined();
    expect(event?.kind).toBe("saved");

    unsub?.();
  });

  test("throws when external listener limit is exceeded", () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    expect(runtime.watch).toBeDefined();

    // Register up to the limit (64)
    for (let i = 0; i < 64; i++) {
      runtime.watch?.(() => {});
    }

    // The 65th listener should throw
    expect(() => runtime.watch?.(() => {})).toThrow(/external listener limit.*64.*reached/);
  });

  test("dispose calls store.dispose when available", () => {
    const store = createInMemoryForgeStore();
    const disposeSpy = mock(() => {});
    // Attach a dispose method to the store
    const storeWithDispose = { ...store, dispose: disposeSpy };

    const runtime = createForgeRuntime({ store: storeWithDispose, executor: mockTiered() });
    runtime.dispose?.();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("dispose works when store has no dispose method", () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // Should not throw even though store has no dispose
    expect(() => runtime.dispose?.()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// On-load integrity verification
// ---------------------------------------------------------------------------

describe("createForgeRuntime — integrity verification", () => {
  test("resolveTool returns undefined when content id is tampered", async () => {
    const store = createInMemoryForgeStore();
    // Save with a bogus id that doesn't match the content
    await store.save(
      testToolArtifact({
        id: brickId("wrong-id-that-does-not-match"),
        name: "tampered",
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const tool = await runtime.resolveTool("tampered");

    expect(tool).toBeUndefined();
  });

  test("resolveTool succeeds when content id is valid", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "valid-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const tool = await runtime.resolveTool("valid-tool");

    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("valid-tool");
  });

  test("integrity result is cached — second resolve skips re-verification", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "cached-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // First resolve — verifies integrity
    const first = await runtime.resolveTool("cached-tool");
    expect(first).toBeDefined();

    // Second resolve — uses cached integrity result (same content hash)
    const second = await runtime.resolveTool("cached-tool");
    expect(second).toBeDefined();
  });

  test("integrity cache is cleared on store change", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "evolving-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // First resolve caches integrity
    const first = await runtime.resolveTool("evolving-tool");
    expect(first).toBeDefined();

    // Save a new version — triggers cache invalidation
    const newImpl = "return input.x + 1;";
    await store.save(
      testToolArtifact({
        name: "evolving-tool",
        implementation: newImpl,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    // After cache invalidation, re-verifies with new content
    const second = await runtime.resolveTool("evolving-tool");
    expect(second).toBeDefined();
  });

  test("failed integrity is cached — tampered tool stays rejected", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      testToolArtifact({
        id: brickId("tampered-hash"),
        name: "bad-tool",
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // First resolve — detects tamper, caches failure
    const first = await runtime.resolveTool("bad-tool");
    expect(first).toBeUndefined();

    // Second resolve — uses cached failure
    const second = await runtime.resolveTool("bad-tool");
    expect(second).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// On-load attestation verification (with signer)
// ---------------------------------------------------------------------------

describe("createForgeRuntime — attestation verification", () => {
  function createTestSigner(): SigningBackend {
    const key = new Uint8Array(32).fill(42);
    const hmac = (data: Uint8Array): Uint8Array => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(key);
      hasher.update(data);
      return new Uint8Array(hasher.digest());
    };
    return {
      algorithm: "hmac-sha256",
      sign: (data: Uint8Array): Uint8Array => hmac(data),
      verify: (data: Uint8Array, signature: Uint8Array): boolean => {
        const expected = hmac(data);
        if (expected.length !== signature.length) return false;
        // let justified: mutable accumulator for constant-time comparison
        let diff = 0;
        for (let i = 0; i < expected.length; i++) {
          diff |= (expected[i] ?? 0) ^ (signature[i] ?? 0);
        }
        return diff === 0;
      },
    };
  }

  test("resolveTool succeeds with valid attestation", async () => {
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();

    const brick = testToolArtifact({ name: "signed-tool" });
    // Sign the provenance
    const signedProvenance = await signAttestation(brick.provenance, signer);
    await store.save({ ...brick, provenance: signedProvenance });

    const runtime = createForgeRuntime({ store, executor: mockTiered(), signer });
    const tool = await runtime.resolveTool("signed-tool");

    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("signed-tool");
  });

  test("resolveTool returns undefined with invalid attestation signature", async () => {
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();

    const brick = testToolArtifact({ name: "forged-sig" });
    // Attach a fake attestation with wrong signature
    const fakeProvenance = {
      ...brick.provenance,
      attestation: {
        algorithm: "hmac-sha256",
        signature: "0".repeat(64),
      },
    };
    await store.save({ ...brick, provenance: fakeProvenance });

    const runtime = createForgeRuntime({ store, executor: mockTiered(), signer });
    const tool = await runtime.resolveTool("forged-sig");

    expect(tool).toBeUndefined();
  });

  test("resolveTool succeeds without attestation when signer provided (attestation optional)", async () => {
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();

    // Save a brick with no attestation — content id is still valid
    await store.save(testToolArtifact({ name: "unsigned-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered(), signer });
    const tool = await runtime.resolveTool("unsigned-tool");

    // verifyBrickAttestation passes when no attestation present (only checks hash)
    expect(tool).toBeDefined();
  });
});
