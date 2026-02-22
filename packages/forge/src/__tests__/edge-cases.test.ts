/**
 * 12 mandatory edge case tests — security + correctness.
 */

import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import type { ForgeError } from "../errors.js";
import { checkGovernance } from "../governance.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeToolTool } from "../tools/forge-tool.js";
import type { ForgeDeps } from "../tools/shared.js";
import type {
  BrickArtifact,
  ForgeContext,
  ForgeInput,
  SandboxExecutor,
  ToolArtifact,
} from "../types.js";
import { verify } from "../verify.js";
import { verifyStatic } from "../verify-static.js";

const DEFAULT_VERIFICATION = createDefaultForgeConfig().verification;

const DEFAULT_CONTEXT: ForgeContext = {
  agentId: "agent-1",
  depth: 0,
  sessionId: "session-1",
  forgesThisSession: 0,
};

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: mockExecutor(),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: DEFAULT_CONTEXT,
    ...overrides,
  };
}

describe("Edge case 1: __proto__ / constructor in schema keys", () => {
  test("rejects schema with 'constructor' key", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object", properties: { constructor: { type: "string" } } },
      implementation: "return 1;",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_SCHEMA");
    }
  });

  test("rejects schema with 'prototype' key", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object", properties: { prototype: { type: "string" } } },
      implementation: "return 1;",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });
});

describe("Edge case 2: Name with path traversal", () => {
  test("rejects name like ../../../etc/passwd", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "../../../etc/passwd",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_NAME");
    }
  });

  test("rejects name with backslash traversal", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "..\\..\\etc\\passwd",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });
});

describe("Edge case 3: Implementation importing node:child_process", () => {
  test("sandbox rejects via permission error", async () => {
    const executor: SandboxExecutor = {
      execute: async () => ({
        ok: false,
        error: {
          code: "PERMISSION",
          message: "permission denied: cannot import node:child_process",
          durationMs: 1,
        },
      }),
    };
    const input: ForgeInput = {
      kind: "tool",
      name: "malicious",
      description: "Evil tool",
      inputSchema: { type: "object" },
      implementation: 'import { exec } from "node:child_process";',
    };
    const config = createDefaultForgeConfig();
    const result = await verify(input, DEFAULT_CONTEXT, executor, [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("sandbox");
      if (result.error.stage === "sandbox") {
        expect(result.error.code).toBe("PERMISSION");
      }
    }
  });
});

describe("Edge case 4: Forge at depth > maxForgeDepth", () => {
  test("governance rejects deep forging", () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 1 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const result = checkGovernance(context, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_DEPTH");
    }
  });
});

describe("Edge case 5: N+1th forge when maxForgesPerSession = N", () => {
  test("governance rejects at limit", () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, forgesThisSession: 3 };
    const result = checkGovernance(context, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_SESSION_FORGES");
    }
  });
});

describe("Edge case 6: Scope promotion without HITL when required", () => {
  test("returns requiresHumanApproval", async () => {
    const { checkScopePromotion } = await import("../governance.js");
    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: true,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "sandbox",
      },
    });
    const result = checkScopePromotion("agent", "zone", "sandbox", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(true);
    }
  });
});

describe("Edge case 7: Concurrent forge attempts — no shared state corruption", () => {
  test("concurrent saves to same store do not corrupt data", async () => {
    const store = createInMemoryForgeStore();
    const bricks: readonly ToolArtifact[] = Array.from({ length: 10 }, (_, i) => ({
      id: `brick_${i}`,
      kind: "tool" as const,
      name: `tool-${i}`,
      description: `Tool ${i}`,
      scope: "agent" as const,
      trustTier: "sandbox" as const,
      lifecycle: "active" as const,
      createdBy: "agent-1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "test-hash",
      implementation: `return ${i};`,
      inputSchema: { type: "object" },
    }));

    // Save all concurrently
    await Promise.all(bricks.map((b) => store.save(b)));

    // All should be retrievable
    const results = await store.search({});
    expect(results.ok).toBe(true);
    if (results.ok) {
      expect(results.value.length).toBe(10);
    }
  });
});

describe("Edge case 8: Duplicate brick name in same scope", () => {
  test("second save overwrites first (store allows by id)", async () => {
    const store = createInMemoryForgeStore();
    const brick1: ToolArtifact = {
      id: "same-id",
      kind: "tool",
      name: "duplicate",
      description: "First",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "agent-1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "test-hash",
      implementation: "return 1;",
      inputSchema: { type: "object" },
    };
    const brick2: ToolArtifact = {
      ...brick1,
      description: "Second",
    };

    await store.save(brick1);
    await store.save(brick2);

    const result = await store.load("same-id");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("Second");
    }
  });
});

describe("Edge case 9: Empty testCases array — Stage 3 passes", () => {
  test("passes self-test with no tests to fail", async () => {
    const config = createDefaultForgeConfig();
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
      testCases: [],
    };
    const result = await verify(input, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(true);
  });
});

describe("Edge case 10: SandboxExecutor returns CRASH error", () => {
  test("verify propagates structured sandbox error", async () => {
    const executor: SandboxExecutor = {
      execute: async () => ({
        ok: false,
        error: { code: "CRASH", message: "unexpected null reference", durationMs: 1 },
      }),
    };
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "broken code",
    };
    const config = createDefaultForgeConfig();
    const result = await verify(input, DEFAULT_CONTEXT, executor, [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("sandbox");
      if (result.error.stage === "sandbox") {
        expect(result.error.code).toBe("CRASH");
      }
    }
  });
});

describe("Edge case 11: ForgeStore.save() failure after verification", () => {
  test("returns error when store save fails", async () => {
    const failingStore = {
      save: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
      search: async () => ({ ok: true as const, value: [] as readonly BrickArtifact[] }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
    };

    const tool = createForgeToolTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: false; readonly error: ForgeError };

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("disk full");
  });
});

describe("Edge case 12: Only valid BrickLifecycle transitions", () => {
  test("store update changes lifecycle from active to deprecated", async () => {
    const store = createInMemoryForgeStore();
    const brick: ToolArtifact = {
      id: "b1",
      kind: "tool",
      name: "myTool",
      description: "A tool",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "agent-1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "test-hash",
      implementation: "return 1;",
      inputSchema: { type: "object" },
    };
    await store.save(brick);

    await store.update("b1", { lifecycle: "deprecated" });
    const result = await store.load("b1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lifecycle).toBe("deprecated");
    }
  });

  test("store update changes lifecycle from draft to verifying", async () => {
    const store = createInMemoryForgeStore();
    const brick: ToolArtifact = {
      id: "b1",
      kind: "tool",
      name: "myTool",
      description: "A tool",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "draft",
      createdBy: "agent-1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "test-hash",
      implementation: "return 1;",
      inputSchema: { type: "object" },
    };
    await store.save(brick);

    await store.update("b1", { lifecycle: "verifying" });
    const result = await store.load("b1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lifecycle).toBe("verifying");
    }
  });
});
