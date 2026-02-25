import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult } from "../types.js";
import { createForgeResolverTool } from "./forge-resolver.js";
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

describe("createForgeResolverTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeResolverTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_resolver");
    expect(tool.trustTier).toBe("promoted");
  });

  test("forges resolver artifact and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeResolverTool(deps);

    const result = (await tool.execute({
      name: "fileResolver",
      description: "File-based tool resolver",
      implementation: "return { discover: async () => [], load: async () => undefined };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("resolver");
    expect(result.value.name).toBe("fileResolver");
    expect(result.value.trustTier).toBe("sandbox");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.kind).toBe("resolver");
    }
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeResolverTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "A resolver",
      implementation: "return {};",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  test("returns verification report in result", async () => {
    const tool = createForgeResolverTool(createDeps());
    const result = (await tool.execute({
      name: "myResolver",
      description: "A resolver",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(4);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const tool = createForgeResolverTool(createDeps());
    const result = (await tool.execute({
      name: "myResolver",
      description: "A resolver",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const tool = createForgeResolverTool(createDeps());
    const result = (await tool.execute({
      name: "myResolver",
      description: "A resolver",
      implementation: "return {};",
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

    const tool = createForgeResolverTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myResolver",
      description: "A resolver",
      implementation: "return {};",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("SAVE_FAILED");
  });

  test("rejects null input with validation error", async () => {
    const tool = createForgeResolverTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createForgeResolverTool(createDeps());
    const result = (await tool.execute({ name: "myResolver" })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("description");
  });

  test("propagates files to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeResolverTool(deps);

    const result = (await tool.execute({
      name: "filesResolver",
      description: "A resolver with files",
      implementation: "return {};",
      files: { "lib/scanner.ts": "export const scan = () => [];" },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.files).toEqual({
        "lib/scanner.ts": "export const scan = () => [];",
      });
    }
  });

  test("propagates requires to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeResolverTool(deps);

    const result = (await tool.execute({
      name: "reqResolver",
      description: "A resolver with requires",
      implementation: "return {};",
      requires: { bins: ["find"], tools: ["scanner"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.requires).toEqual({ bins: ["find"], tools: ["scanner"] });
    }
  });

  test("propagates configSchema to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeResolverTool(deps);

    const result = (await tool.execute({
      name: "schemaResolver",
      description: "A resolver with config schema",
      implementation: "return {};",
      configSchema: {
        type: "object",
        properties: { rootDir: { type: "string" } },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.configSchema).toEqual({
        type: "object",
        properties: { rootDir: { type: "string" } },
      });
    }
  });
});
