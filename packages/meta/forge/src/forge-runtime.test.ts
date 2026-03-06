/**
 * Unit tests for createForgeRuntime factory.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentDescriptor, SigningBackend, SkillComponent, ToolArtifact } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { signAttestation } from "@koi/forge-integrity";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { SandboxExecutor } from "@koi/forge-types";
import { computeBrickId } from "@koi/hash";
import {
  createTestAgentArtifact,
  createTestSkillArtifact,
  DEFAULT_PROVENANCE,
} from "@koi/test-utils";
import { createForgeRuntime } from "./forge-runtime.js";

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
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeRuntime", () => {
  test("resolveTool returns Tool for active tool in store", async () => {
    const store = createInMemoryForgeStore();
    const brick = testToolArtifact({ name: "adder" });
    await store.save(brick);

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const tool = await runtime.resolveTool("adder");

    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("adder");
  });

  test("resolveTool returns undefined for non-existent tool", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

    const tool = await runtime.resolveTool("nonexistent");
    expect(tool).toBeUndefined();
  });

  test("resolveTool returns undefined for inactive (draft) tool", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "draft-tool", lifecycle: "draft" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
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

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const descriptors = await runtime.toolDescriptors();

    expect(descriptors).toHaveLength(2);
    const names = descriptors.map((d) => d.name);
    expect(names).toContain("tool-a");
    expect(names).toContain("tool-b");
  });

  test("toolDescriptors returns empty array when store is empty", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

    const descriptors = await runtime.toolDescriptors();
    expect(descriptors).toHaveLength(0);
  });

  test("cache invalidation: forge new tool → watch → resolveTool finds it", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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

    const runtime = createForgeRuntime({ store: storeWithDispose, executor: mockExecutor() });
    runtime.dispose?.();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("dispose works when store has no dispose method", () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const tool = await runtime.resolveTool("tampered");

    expect(tool).toBeUndefined();
  });

  test("resolveTool succeeds when content id is valid", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "valid-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const tool = await runtime.resolveTool("valid-tool");

    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("valid-tool");
  });

  test("integrity result is cached — second resolve skips re-verification", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "cached-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

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

    const runtime = createForgeRuntime({ store, executor: mockExecutor(), signer });
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

    const runtime = createForgeRuntime({ store, executor: mockExecutor(), signer });
    const tool = await runtime.resolveTool("forged-sig");

    expect(tool).toBeUndefined();
  });

  test("resolveTool succeeds without attestation when signer provided (attestation optional)", async () => {
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();

    // Save a brick with no attestation — content id is still valid
    await store.save(testToolArtifact({ name: "unsigned-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor(), signer });
    const tool = await runtime.resolveTool("unsigned-tool");

    // verifyBrickAttestation passes when no attestation present (only checks hash)
    expect(tool).toBeDefined();
  });

  test("integrity cache works with attestation-backed verification", async () => {
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();

    const brick = testToolArtifact({ name: "cache-attest-tool" });
    const signedProvenance = await signAttestation(brick.provenance, signer);
    await store.save({ ...brick, provenance: signedProvenance });

    const runtime = createForgeRuntime({ store, executor: mockExecutor(), signer });

    // First resolve — verifies attestation, caches result
    const first = await runtime.resolveTool("cache-attest-tool");
    expect(first).toBeDefined();

    // Second resolve — uses cached result
    const second = await runtime.resolveTool("cache-attest-tool");
    expect(second).toBeDefined();
  });

  test("failed attestation is cached — forged sig stays rejected", async () => {
    const signer = createTestSigner();
    const store = createInMemoryForgeStore();

    const brick = testToolArtifact({ name: "bad-attest" });
    const fakeProvenance = {
      ...brick.provenance,
      attestation: { algorithm: "hmac-sha256", signature: "ab".repeat(32) },
    };
    await store.save({ ...brick, provenance: fakeProvenance });

    const runtime = createForgeRuntime({ store, executor: mockExecutor(), signer });

    // First resolve — detects invalid attestation, caches failure
    const first = await runtime.resolveTool("bad-attest");
    expect(first).toBeUndefined();

    // Second resolve — uses cached failure
    const second = await runtime.resolveTool("bad-attest");
    expect(second).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolve() — generic per-kind resolution
// ---------------------------------------------------------------------------

interface ResolveCase {
  readonly kind: "skill" | "agent";
  readonly factory: (overrides?: Record<string, unknown>) => import("@koi/core").BrickArtifact;
  readonly check: (v: unknown) => boolean;
}

const RESOLVE_CASES: ResolveCase[] = [
  {
    kind: "skill",
    factory: (overrides) => createTestSkillArtifact(overrides),
    check: (v: unknown) => typeof v === "object" && v !== null && "content" in v,
  },
  {
    kind: "agent",
    factory: (overrides) => createTestAgentArtifact(overrides),
    check: (v: unknown) => typeof v === "object" && v !== null && "manifestYaml" in v,
  },
];

describe.each(RESOLVE_CASES)("resolve('$kind', name)", ({ kind, factory, check }) => {
  test("returns component for active brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(factory({ name: `test-${kind}` }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = await runtime.resolve?.(kind, `test-${kind}`);

    expect(result).toBeDefined();
    expect(check(result)).toBe(true);
  });

  test("returns undefined for unknown name", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

    const result = await runtime.resolve?.(kind, "nonexistent");
    expect(result).toBeUndefined();
  });

  test("respects cache invalidation", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

    // Initially no bricks
    const before = await runtime.resolve?.(kind, `new-${kind}`);
    expect(before).toBeUndefined();

    // Save a new brick
    await store.save(factory({ name: `new-${kind}` }));
    await new Promise((r) => setTimeout(r, 10));

    // After store watch fires, cache invalidated
    const after = await runtime.resolve?.(kind, `new-${kind}`);
    expect(after).toBeDefined();
    expect(check(after)).toBe(true);
  });
});

describe("resolve() specific behavior", () => {
  test("resolve('tool', name) delegates to resolveTool", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "resolver-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = await runtime.resolve?.("tool", "resolver-tool");

    expect(result).toBeDefined();
    // Tool has descriptor property
    expect(typeof (result as { readonly descriptor: unknown }).descriptor).toBe("object");
  });

  test("resolve('skill') returns SkillComponent shape", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createTestSkillArtifact({
        name: "research",
        description: "Research skill",
        content: "# Research\n\nDo research.",
        tags: ["research"],
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = (await runtime.resolve?.("skill", "research")) as SkillComponent | undefined;

    expect(result).toBeDefined();
    expect(result?.name).toBe("research");
    expect(result?.description).toBe("Research skill");
    expect(result?.content).toBe("# Research\n\nDo research.");
    expect(result?.tags).toEqual(["research"]);
  });

  test("resolve('agent') returns AgentDescriptor shape", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createTestAgentArtifact({
        name: "planner",
        description: "Planner agent",
        manifestYaml: "name: planner\ntype: worker",
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = (await runtime.resolve?.("agent", "planner")) as AgentDescriptor | undefined;

    expect(result).toBeDefined();
    expect(result?.name).toBe("planner");
    expect(result?.description).toBe("Planner agent");
    expect(result?.manifestYaml).toBe("name: planner\ntype: worker");
  });

  test("resolve enforces requires.tools — returns undefined when tool dep missing", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createTestSkillArtifact({
        name: "needs-tool",
        requires: { tools: ["missing-tool"] },
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = await runtime.resolve?.("skill", "needs-tool");
    expect(result).toBeUndefined();
  });

  test("resolve enforces requires.tools — succeeds when tool dep exists", async () => {
    const store = createInMemoryForgeStore();
    // Save the required tool first
    await store.save(testToolArtifact({ name: "dep-tool" }));
    await store.save(
      createTestSkillArtifact({
        name: "has-dep",
        requires: { tools: ["dep-tool"] },
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = await runtime.resolve?.("skill", "has-dep");
    expect(result).toBeDefined();
  });

  test("resolve enforces requires.env — returns undefined when env var missing", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createTestAgentArtifact({
        name: "needs-env",
        requires: { env: ["KOI_TEST_NONEXISTENT_VAR_12345"] },
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = await runtime.resolve?.("agent", "needs-env");
    expect(result).toBeUndefined();
  });

  test("resolve returns undefined for inactive brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createTestSkillArtifact({ name: "draft-skill", lifecycle: "draft" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const result = await runtime.resolve?.("skill", "draft-skill");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveTool — npm package dependency wire-up
// ---------------------------------------------------------------------------

describe("createForgeRuntime — npm dependency wire-up", () => {
  test("resolveTool returns undefined when requires.packages fails audit (blocked package)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      testToolArtifact({
        name: "dep-tool",
        requires: { packages: { "blocked-pkg": "1.0.0" } },
      }),
    );

    const runtime = createForgeRuntime({
      store,
      executor: mockExecutor(),
      dependencyConfig: {
        blockedPackages: ["blocked-pkg"],
        maxDependencies: 20,
        installTimeoutMs: 15_000,
        maxCacheSizeBytes: 1_073_741_824,
        maxWorkspaceAgeDays: 30,
        maxTransitiveDependencies: 200,
        maxBrickMemoryMb: 256,
        maxBrickPids: 32,
      },
    });

    const tool = await runtime.resolveTool("dep-tool");
    expect(tool).toBeUndefined();
  });

  test("resolveTool returns undefined when requires.packages exceeds max dependencies", async () => {
    const store = createInMemoryForgeStore();
    const tooManyDeps: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      tooManyDeps[`pkg-${String(i)}`] = "1.0.0";
    }
    await store.save(
      testToolArtifact({
        name: "heavy-tool",
        requires: { packages: tooManyDeps },
      }),
    );

    const runtime = createForgeRuntime({
      store,
      executor: mockExecutor(),
      dependencyConfig: {
        maxDependencies: 2, // Limit to 2 — tool has 5
        installTimeoutMs: 15_000,
        maxCacheSizeBytes: 1_073_741_824,
        maxWorkspaceAgeDays: 30,
        maxTransitiveDependencies: 200,
        maxBrickMemoryMb: 256,
        maxBrickPids: 32,
      },
    });

    const tool = await runtime.resolveTool("heavy-tool");
    expect(tool).toBeUndefined();
  });

  test("resolveTool returns undefined when requires.packages has invalid semver range", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      testToolArtifact({
        name: "range-tool",
        requires: { packages: { lodash: "^4.0.0" } }, // Range, not exact
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const tool = await runtime.resolveTool("range-tool");
    expect(tool).toBeUndefined();
  });

  test("resolveTool succeeds for tool with no requires.packages", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "simple-tool" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const tool = await runtime.resolveTool("simple-tool");
    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("simple-tool");
  });

  test("resolveTool succeeds for tool with empty requires.packages", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      testToolArtifact({
        name: "empty-deps-tool",
        requires: { packages: {} },
      }),
    );

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });
    const tool = await runtime.resolveTool("empty-deps-tool");
    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("empty-deps-tool");
  });

  test("resolveTool returns undefined when package name not on allowlist", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      testToolArtifact({
        name: "allow-tool",
        requires: { packages: { "not-allowed": "1.0.0" } },
      }),
    );

    const runtime = createForgeRuntime({
      store,
      executor: mockExecutor(),
      dependencyConfig: {
        allowedPackages: ["only-this-one"],
        maxDependencies: 20,
        installTimeoutMs: 15_000,
        maxCacheSizeBytes: 1_073_741_824,
        maxWorkspaceAgeDays: 30,
        maxTransitiveDependencies: 200,
        maxBrickMemoryMb: 256,
        maxBrickPids: 32,
      },
    });

    const tool = await runtime.resolveTool("allow-tool");
    expect(tool).toBeUndefined();
  });

  test("concurrent resolveTool calls for same audit-failing brick both return undefined", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      testToolArtifact({
        name: "concurrent-blocked",
        requires: { packages: { "evil-pkg": "1.0.0" } },
      }),
    );

    const runtime = createForgeRuntime({
      store,
      executor: mockExecutor(),
      dependencyConfig: {
        blockedPackages: ["evil-pkg"],
        maxDependencies: 20,
        installTimeoutMs: 15_000,
        maxCacheSizeBytes: 1_073_741_824,
        maxWorkspaceAgeDays: 30,
        maxTransitiveDependencies: 200,
        maxBrickMemoryMb: 256,
        maxBrickPids: 32,
      },
    });

    // Fire two concurrent resolves — both must return undefined (audit gate)
    const [tool1, tool2] = await Promise.all([
      runtime.resolveTool("concurrent-blocked"),
      runtime.resolveTool("concurrent-blocked"),
    ]);

    expect(tool1).toBeUndefined();
    expect(tool2).toBeUndefined();
  });

  test("concurrent resolveTool calls for non-dep tools both resolve correctly", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "tool-a", implementation: "return 1;" }));
    await store.save(testToolArtifact({ name: "tool-b", implementation: "return 2;" }));

    const runtime = createForgeRuntime({ store, executor: mockExecutor() });

    const [toolA, toolB] = await Promise.all([
      runtime.resolveTool("tool-a"),
      runtime.resolveTool("tool-b"),
    ]);

    expect(toolA).toBeDefined();
    expect(toolA?.descriptor.name).toBe("tool-a");
    expect(toolB).toBeDefined();
    expect(toolB?.descriptor.name).toBe("tool-b");
  });
});
