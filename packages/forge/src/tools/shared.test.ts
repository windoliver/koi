import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeContext } from "../types.js";
import type { ForgeDeps } from "./shared.js";
import { createForgeTool } from "./shared.js";

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: { execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }) },
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    ...overrides,
  };
}

describe("createForgeTool — factory", () => {
  test("creates tool with correct descriptor", () => {
    const deps = createDeps();
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: "done" }),
      },
      deps,
    );
    expect(tool.descriptor.name).toBe("test_tool");
    expect(tool.descriptor.description).toBe("Test");
    expect(tool.trustTier).toBe("promoted");
  });

  test("rejects execution when forge is disabled", async () => {
    const deps = createDeps({ config: createDefaultForgeConfig({ enabled: false }) });
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: "done" }),
      },
      deps,
    );
    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly stage: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
  });

  test("rejects execution when depth exceeds max", async () => {
    const context: ForgeContext = { agentId: "a", depth: 5, sessionId: "s", forgesThisSession: 0 };
    const deps = createDeps({ context, config: createDefaultForgeConfig({ maxForgeDepth: 1 }) });
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: "done" }),
      },
      deps,
    );
    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly stage: string };
    };
    expect(result.ok).toBe(false);
  });

  test("delegates to handler when governance passes", async () => {
    const deps = createDeps();
    let handlerCalled = false;
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => {
          handlerCalled = true;
          return { ok: true, value: "done" };
        },
      },
      deps,
    );
    await tool.execute({});
    expect(handlerCalled).toBe(true);
  });
});
