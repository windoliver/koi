import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult } from "../types.js";
import { createForgeChannelTool } from "./forge-channel.js";
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

describe("createForgeChannelTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeChannelTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_channel");
    expect(tool.trustTier).toBe("promoted");
  });

  test("forges channel artifact and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeChannelTool(deps);

    const result = (await tool.execute({
      name: "slackChannel",
      description: "Slack I/O channel adapter",
      implementation: "return { send: async (msg) => {}, onMessage: (cb) => () => {} };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("channel");
    expect(result.value.name).toBe("slackChannel");
    expect(result.value.trustTier).toBe("sandbox");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.kind).toBe("channel");
    }
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeChannelTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "A channel",
      implementation: "return {};",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  test("returns verification report in result", async () => {
    const tool = createForgeChannelTool(createDeps());
    const result = (await tool.execute({
      name: "myChannel",
      description: "A channel",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(6);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const tool = createForgeChannelTool(createDeps());
    const result = (await tool.execute({
      name: "myChannel",
      description: "A channel",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const tool = createForgeChannelTool(createDeps());
    const result = (await tool.execute({
      name: "myChannel",
      description: "A channel",
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

    const tool = createForgeChannelTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myChannel",
      description: "A channel",
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
    const tool = createForgeChannelTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createForgeChannelTool(createDeps());
    const result = (await tool.execute({ name: "myChannel" })) as {
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
    const tool = createForgeChannelTool(deps);

    const result = (await tool.execute({
      name: "filesChannel",
      description: "A channel with files",
      implementation: "return {};",
      files: { "lib/slack-api.ts": "export const post = async (url: string) => {};" },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.files).toEqual({
        "lib/slack-api.ts": "export const post = async (url: string) => {};",
      });
    }
  });

  test("propagates requires to artifact", async () => {
    const store = createInMemoryForgeStore();
    const deps = createDeps({ store });
    const tool = createForgeChannelTool(deps);

    const result = (await tool.execute({
      name: "reqChannel",
      description: "A channel with requires",
      implementation: "return {};",
      requires: { bins: ["curl"], env: ["SLACK_TOKEN"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.requires).toEqual({ bins: ["curl"], env: ["SLACK_TOKEN"] });
    }
  });
});
