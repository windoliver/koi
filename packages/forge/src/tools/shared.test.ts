import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeContext } from "../types.js";
import type { ForgeDeps } from "./shared.js";
import { computeContentHash, createForgeTool } from "./shared.js";

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

describe("computeContentHash", () => {
  test("returns consistent hash for same content", () => {
    const h1 = computeContentHash("hello");
    const h2 = computeContentHash("hello");
    expect(h1).toBe(h2);
  });

  test("returns different hash for different content", () => {
    const h1 = computeContentHash("hello");
    const h2 = computeContentHash("world");
    expect(h1).not.toBe(h2);
  });

  test("without files, hash is unchanged from content-only", () => {
    const withoutFiles = computeContentHash("hello");
    const withUndefined = computeContentHash("hello", undefined);
    expect(withoutFiles).toBe(withUndefined);
  });

  test("with files, hash differs from content-only", () => {
    const withoutFiles = computeContentHash("hello");
    const withFiles = computeContentHash("hello", { "lib/a.ts": "export const a = 1;" });
    expect(withoutFiles).not.toBe(withFiles);
  });

  test("file order does not affect hash (deterministic sort)", () => {
    const files1 = { "b.ts": "b content", "a.ts": "a content" };
    const files2 = { "a.ts": "a content", "b.ts": "b content" };
    const h1 = computeContentHash("hello", files1);
    const h2 = computeContentHash("hello", files2);
    expect(h1).toBe(h2);
  });

  test("different file content produces different hash", () => {
    const h1 = computeContentHash("hello", { "a.ts": "v1" });
    const h2 = computeContentHash("hello", { "a.ts": "v2" });
    expect(h1).not.toBe(h2);
  });
});
