import { describe, expect, test } from "bun:test";
import type { GovernanceController } from "@koi/core";
import { brickId } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeContext } from "../types.js";
import type { ForgeDeps } from "./shared.js";
import { buildBaseFields, createForgeTool, parseSkillInput, parseToolInput } from "./shared.js";

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: {
      execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
    },
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
      brickId("brick_123"),
      { name: "myBrick", description: "A brick", tags: ["tag1"] },
      report,
      deps,
    );
    expect(base.id).toBe(brickId("brick_123"));
    expect(base.name).toBe("myBrick");
    expect(base.description).toBe("A brick");
    expect(base.tags).toEqual(["tag1"]);
    expect(base.trustTier).toBe("sandbox");
    expect(base.scope).toBe("agent");
    expect(base.lifecycle).toBe("active");
    expect(base.version).toBe("0.0.1");
    expect(base.usageCount).toBe(0);
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
      brickId("brick_456"),
      { name: "myBrick", description: "A brick" },
      report,
      deps,
    );
    expect(base.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Controller + onForgeConsumed integration
// ---------------------------------------------------------------------------

function createMockController(overrides?: {
  readonly checks?: Readonly<
    Record<
      string,
      | { readonly ok: true }
      | {
          readonly ok: false;
          readonly variable: string;
          readonly reason: string;
          readonly retryable: boolean;
        }
    >
  >;
}): GovernanceController {
  const checks = overrides?.checks ?? {};
  return {
    check: (variable: string) => checks[variable] ?? { ok: true as const },
    checkAll: () => ({ ok: true as const }),
    record: () => undefined,
    snapshot: () => ({ timestamp: Date.now(), readings: [], healthy: true, violations: [] }),
    variables: () => new Map(),
    reading: () => undefined,
  };
}

describe("createForgeTool — controller passthrough", () => {
  test("passes controller to checkGovernance when provided", async () => {
    const controller = createMockController({
      checks: {
        forge_budget: {
          ok: false,
          variable: "forge_budget",
          reason: "budget exhausted",
          retryable: true,
        },
      },
    });
    const deps = createDeps({ controller });
    const tool = createForgeTool(
      {
        name: "forge_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: { forgesConsumed: 1 } }),
      },
      deps,
    );
    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };
    // Controller rejects → governance error
    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("MAX_SESSION_FORGES");
  });

  test("passes controller and governance succeeds when controller allows", async () => {
    const controller = createMockController();
    let handlerCalled = false;
    const deps = createDeps({ controller });
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

describe("createForgeTool — onForgeConsumed callback", () => {
  test("calls onForgeConsumed(1) after successful new forge", async () => {
    let consumedArg: number | undefined;
    const deps = createDeps({
      onForgeConsumed: (n) => {
        consumedArg = n;
      },
    });
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: { forgesConsumed: 1 } }),
      },
      deps,
    );
    await tool.execute({});
    expect(consumedArg).toBe(1);
  });

  test("does NOT call onForgeConsumed on dedup (forgesConsumed: 0)", async () => {
    let called = false;
    const deps = createDeps({
      onForgeConsumed: () => {
        called = true;
      },
    });
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: { forgesConsumed: 0 } }),
      },
      deps,
    );
    await tool.execute({});
    expect(called).toBe(false);
  });

  test("does NOT call onForgeConsumed on governance failure", async () => {
    let called = false;
    const deps = createDeps({
      config: createDefaultForgeConfig({ enabled: false }),
      onForgeConsumed: () => {
        called = true;
      },
    });
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: { forgesConsumed: 1 } }),
      },
      deps,
    );
    await tool.execute({});
    expect(called).toBe(false);
  });

  test("does NOT call onForgeConsumed on handler error", async () => {
    let called = false;
    const deps = createDeps({
      onForgeConsumed: () => {
        called = true;
      },
    });
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({
          ok: false,
          error: { stage: "sandbox" as const, code: "CRASH" as const, message: "boom" },
        }),
      },
      deps,
    );
    await tool.execute({});
    expect(called).toBe(false);
  });

  test("does NOT call onForgeConsumed when callback is not provided", async () => {
    // Just verify no error when onForgeConsumed is undefined
    const deps = createDeps();
    const tool = createForgeTool(
      {
        name: "test_tool",
        description: "Test",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, value: { forgesConsumed: 1 } }),
      },
      deps,
    );
    // Should not throw
    await tool.execute({});
  });
});
