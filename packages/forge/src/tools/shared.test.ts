import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeContext } from "../types.js";
import type { ForgeDeps } from "./shared.js";
import {
  buildBaseFields,
  computeContentHash,
  createForgeTool,
  parseSkillInput,
  parseToolInput,
} from "./shared.js";

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
      execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
    }),
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

describe("parseForgeInput", () => {
  test("parses valid tool input", () => {
    const result = parseToolInput({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("myTool");
    }
  });

  test("returns MISSING_FIELD for null input", () => {
    const result = parseToolInput(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("static");
      expect(result.error.code).toBe("MISSING_FIELD");
    }
  });

  test("returns MISSING_FIELD for missing required field", () => {
    const result = parseToolInput({
      name: "myTool",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("static");
      expect(result.error.code).toBe("MISSING_FIELD");
      expect(result.error.message).toContain("description");
    }
  });

  test("returns INVALID_TYPE for wrong field type", () => {
    const result = parseToolInput({
      name: 123,
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("static");
      expect(result.error.code).toBe("INVALID_TYPE");
      expect(result.error.message).toContain("name");
    }
  });

  test("parses valid skill input with body", () => {
    const result = parseSkillInput({
      name: "mySkill",
      description: "A skill",
      body: "# Content",
      tags: ["math"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBe("# Content");
      expect(result.value.tags).toEqual(["math"]);
    }
  });
});

describe("buildBaseFields", () => {
  test("returns correct base fields", () => {
    const deps = createDeps();
    const report = {
      stages: [],
      finalTrustTier: "sandbox" as const,
      totalDurationMs: 10,
      passed: true,
    };
    const base = buildBaseFields(
      "brick_123",
      { name: "myBrick", description: "A brick", tags: ["tag1"] },
      report,
      deps,
      "abc123",
    );
    expect(base.id).toBe("brick_123");
    expect(base.name).toBe("myBrick");
    expect(base.description).toBe("A brick");
    expect(base.tags).toEqual(["tag1"]);
    expect(base.trustTier).toBe("sandbox");
    expect(base.scope).toBe("agent");
    expect(base.lifecycle).toBe("active");
    expect(base.createdBy).toBe("agent-1");
    expect(base.version).toBe("0.0.1");
    expect(base.usageCount).toBe(0);
    expect(base.contentHash).toBe("abc123");
  });

  test("defaults tags to empty array when undefined", () => {
    const deps = createDeps();
    const report = {
      stages: [],
      finalTrustTier: "sandbox" as const,
      totalDurationMs: 0,
      passed: true,
    };
    const base = buildBaseFields(
      "brick_456",
      { name: "myBrick", description: "A brick" },
      report,
      deps,
      "hash",
    );
    expect(base.tags).toEqual([]);
  });
});
