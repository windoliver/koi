import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult } from "../types.js";
import { createForgeProviderTool } from "./forge-provider.js";
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

describe("createForgeProviderTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeProviderTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_provider");
    expect(tool.trustTier).toBe("promoted");
  });

  test("forges provider artifact and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeProviderTool(deps);

    const result = (await tool.execute({
      name: "metricsProvider",
      description: "Metrics component provider",
      implementation: "return { name: 'metrics', attach: async () => new Map() };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("provider");
    expect(result.value.name).toBe("metricsProvider");
    expect(result.value.trustTier).toBe("sandbox");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.kind).toBe("provider");
    }
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeProviderTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "A provider",
      implementation: "return {};",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  test("returns verification report in result", async () => {
    const tool = createForgeProviderTool(createDeps());
    const result = (await tool.execute({
      name: "myProvider",
      description: "A provider",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(4);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const tool = createForgeProviderTool(createDeps());
    const result = (await tool.execute({
      name: "myProvider",
      description: "A provider",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const tool = createForgeProviderTool(createDeps());
    const result = (await tool.execute({
      name: "myProvider",
      description: "A provider",
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

    const tool = createForgeProviderTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myProvider",
      description: "A provider",
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
    const tool = createForgeProviderTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createForgeProviderTool(createDeps());
    const result = (await tool.execute({ name: "myProvider" })) as {
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
    const tool = createForgeProviderTool(deps);

    const result = (await tool.execute({
      name: "filesProvider",
      description: "A provider with files",
      implementation: "return {};",
      files: { "lib/metrics.ts": "export const counter = () => 0;" },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.files).toEqual({
        "lib/metrics.ts": "export const counter = () => 0;",
      });
    }
  });

  test("propagates requires to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeProviderTool(deps);

    const result = (await tool.execute({
      name: "reqProvider",
      description: "A provider with requires",
      implementation: "return {};",
      requires: { env: ["METRICS_ENDPOINT"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.requires).toEqual({ env: ["METRICS_ENDPOINT"] });
    }
  });

  test("propagates configSchema to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeProviderTool(deps);

    const result = (await tool.execute({
      name: "schemaProvider",
      description: "A provider with config schema",
      implementation: "return {};",
      configSchema: {
        type: "object",
        properties: { interval: { type: "number" } },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.configSchema).toEqual({
        type: "object",
        properties: { interval: { type: "number" } },
      });
    }
  });
});
