import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, SigningBackend, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult } from "../types.js";
import { createForgeSkillTool } from "./forge-skill.js";
import { createForgeToolTool } from "./forge-tool.js";
import type { ForgeDeps } from "./shared.js";

function mockTiered(exec: SandboxExecutor): TieredSandboxExecutor {
  return {
    forTier: (tier) => ({
      executor: exec,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: mockTiered({
      execute: async (_code, input, _timeout) => ({
        ok: true,
        value: { output: input, durationMs: 1 },
      }),
    }),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    ...overrides,
  };
}

describe("createForgeToolTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeToolTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_tool");
    expect(tool.trustTier).toBe("promoted");
  });

  test("forges a tool and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeToolTool(deps);

    const result = (await tool.execute({
      name: "calc",
      description: "A calculator",
      inputSchema: { type: "object" },
      implementation: "return input.a + input.b;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("tool");
    expect(result.value.name).toBe("calc");
    expect(result.value.trustTier).toBe("sandbox");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  test("returns verification report in result", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(4);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.forgesConsumed).toBe(1);
  });

  test("returns store error on save failure", async () => {
    const failingStore = {
      save: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      search: async () => ({
        ok: true as const,
        value: [] as readonly import("../types.js").BrickArtifact[],
      }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
    };

    const tool = createForgeToolTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("SAVE_FAILED");
  });

  test("rejects null input with validation error", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute({ name: "myTool" })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("description");
  });

  test("rejects input with wrong field type", async () => {
    const tool = createForgeToolTool(createDeps());
    const result = (await tool.execute({
      name: 123,
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("INVALID_TYPE");
    expect(result.error.message).toContain("name");
    expect(result.error.message).toContain("string");
  });

  test("propagates files to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeToolTool(deps);

    const result = (await tool.execute({
      name: "filesTool",
      description: "A tool with files",
      inputSchema: { type: "object" },
      implementation: "return 1;",
      files: { "lib/utils.ts": "export const add = (a, b) => a + b;" },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.files).toEqual({
        "lib/utils.ts": "export const add = (a, b) => a + b;",
      });
    }
  });

  test("propagates requires to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeToolTool(deps);

    const result = (await tool.execute({
      name: "reqTool",
      description: "A tool with requires",
      inputSchema: { type: "object" },
      implementation: "return 1;",
      requires: { bins: ["python3"], tools: ["search"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.requires).toEqual({ bins: ["python3"], tools: ["search"] });
    }
  });
});

// ---------------------------------------------------------------------------
// Signing attestation tests
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

describe("forge tool with signer", () => {
  test("forged tool has attestation populated when signer provided", async () => {
    const store = createInMemoryForgeStore();
    const signer = createTestSigner();
    const deps = createDeps({ store, signer });
    const tool = createForgeToolTool(deps);

    const result = (await tool.execute({
      name: "signedTool",
      description: "A signed tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.provenance.attestation).toBeDefined();
      expect(loadResult.value.provenance.attestation?.algorithm).toBe("hmac-sha256");
      expect(loadResult.value.provenance.attestation?.signature).toBeTruthy();
      expect(loadResult.value.provenance.attestation?.signature.length).toBeGreaterThan(0);
    }
  });

  test("attestation signature is valid hex string", async () => {
    const store = createInMemoryForgeStore();
    const signer = createTestSigner();
    const deps = createDeps({ store, signer });
    const tool = createForgeToolTool(deps);

    const result = (await tool.execute({
      name: "hexTool",
      description: "A tool with hex sig",
      inputSchema: { type: "object" },
      implementation: "return 2;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      const sig = loadResult.value.provenance.attestation?.signature ?? "";
      expect(sig).toMatch(/^[0-9a-f]+$/);
    }
  });

  test("forged skill has attestation when signer provided", async () => {
    const store = createInMemoryForgeStore();
    const signer = createTestSigner();
    const deps = createDeps({ store, signer });
    const tool = createForgeSkillTool(deps);

    const result = (await tool.execute({
      name: "signedSkill",
      description: "A signed skill",
      body: "# My Skill\n\nDo something useful.",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.provenance.attestation).toBeDefined();
      expect(loadResult.value.provenance.attestation?.algorithm).toBe("hmac-sha256");
    }
  });
});
