import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult } from "../types.js";
import { createForgeMiddlewareTool } from "./forge-middleware.js";
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

describe("createForgeMiddlewareTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeMiddlewareTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_middleware");
    expect(tool.trustTier).toBe("promoted");
  });

  test("forges middleware artifact and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeMiddlewareTool(deps);

    const result = (await tool.execute({
      name: "auditMiddleware",
      description: "Logs all model calls",
      implementation: "return { beforeModel: async (ctx) => ctx };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("middleware");
    expect(result.value.name).toBe("auditMiddleware");
    expect(result.value.trustTier).toBe("sandbox");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.kind).toBe("middleware");
    }
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeMiddlewareTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "A middleware",
      implementation: "return {};",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  test("returns verification report in result", async () => {
    const tool = createForgeMiddlewareTool(createDeps());
    const result = (await tool.execute({
      name: "myMiddleware",
      description: "A middleware",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(6);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const tool = createForgeMiddlewareTool(createDeps());
    const result = (await tool.execute({
      name: "myMiddleware",
      description: "A middleware",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const tool = createForgeMiddlewareTool(createDeps());
    const result = (await tool.execute({
      name: "myMiddleware",
      description: "A middleware",
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

    const tool = createForgeMiddlewareTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myMiddleware",
      description: "A middleware",
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
    const tool = createForgeMiddlewareTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createForgeMiddlewareTool(createDeps());
    const result = (await tool.execute({ name: "myMiddleware" })) as {
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
    const tool = createForgeMiddlewareTool(deps);

    const result = (await tool.execute({
      name: "filesMiddleware",
      description: "A middleware with files",
      implementation: "return {};",
      files: { "lib/helpers.ts": "export const log = (msg: string) => console.log(msg);" },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.files).toEqual({
        "lib/helpers.ts": "export const log = (msg: string) => console.log(msg);",
      });
    }
  });

  test("propagates requires to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeMiddlewareTool(deps);

    const result = (await tool.execute({
      name: "reqMiddleware",
      description: "A middleware with requires",
      implementation: "return {};",
      requires: { env: ["AUDIT_LOG_URL"], tools: ["log"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.requires).toEqual({ env: ["AUDIT_LOG_URL"], tools: ["log"] });
    }
  });
});
