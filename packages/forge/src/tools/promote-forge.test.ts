import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { PromoteResult, ToolArtifact } from "../types.js";
import { createPromoteForgeTool } from "./promote-forge.js";
import type { ForgeDeps } from "./shared.js";

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: "brick_test",
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
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
    ...overrides,
  };
}

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

describe("createPromoteForgeTool", () => {
  test("has correct descriptor", () => {
    const tool = createPromoteForgeTool(createDeps());
    expect(tool.descriptor.name).toBe("promote_forge");
  });

  // --- Scope promotion ---

  test("promotes scope from agent to zone", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", scope: "agent", trustTier: "verified" }));

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "verified",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "zone",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.requiresHumanApproval).toBe(false);
    expect(result.value.changes.scope).toEqual({ from: "agent", to: "zone" });

    // Verify store updated
    const loadResult = await store.load("brick_1");
    if (loadResult.ok) {
      expect(loadResult.value.scope).toBe("zone");
    }
  });

  test("returns requiresHumanApproval for scope promotion when configured", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", scope: "agent", trustTier: "verified" }));

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: true,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "sandbox",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "zone",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(false);
    expect(result.value.requiresHumanApproval).toBe(true);
    expect(result.value.message).toContain("human approval");

    // Verify store NOT updated
    const loadResult = await store.load("brick_1");
    if (loadResult.ok) {
      expect(loadResult.value.scope).toBe("agent");
    }
  });

  test("rejects scope promotion with insufficient trust tier", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", scope: "agent", trustTier: "sandbox" }));

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "verified",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "zone",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("SCOPE_VIOLATION");
  });

  test("allows same-scope (no-op)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", scope: "agent" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "agent",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.scope).toBeUndefined();
  });

  // --- Trust tier promotion ---

  test("promotes trust tier from sandbox to verified", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", trustTier: "sandbox" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetTrustTier: "verified",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.trustTier).toEqual({ from: "sandbox", to: "verified" });

    // Verify store updated
    const loadResult = await store.load("brick_1");
    if (loadResult.ok) {
      expect(loadResult.value.trustTier).toBe("verified");
    }
  });

  test("rejects trust tier demotion", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", trustTier: "verified" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetTrustTier: "sandbox",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("SCOPE_VIOLATION");
    expect(result.error.message).toContain("demotion");
  });

  test("allows same trust tier (no-op)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", trustTier: "sandbox" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetTrustTier: "sandbox",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.trustTier).toBeUndefined();
  });

  // --- Lifecycle transitions ---

  test("transitions lifecycle from active to deprecated", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", lifecycle: "active" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetLifecycle: "deprecated",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.lifecycle).toEqual({ from: "active", to: "deprecated" });
  });

  test("transitions lifecycle from deprecated to failed", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", lifecycle: "deprecated" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetLifecycle: "failed",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.lifecycle).toEqual({ from: "deprecated", to: "failed" });
  });

  test("rejects transition from failed (terminal state)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", lifecycle: "failed" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetLifecycle: "active",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.message).toContain("failed");
  });

  // --- Combined promotions ---

  test("applies scope and trust tier promotion together", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", scope: "agent", trustTier: "sandbox" }));

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "zone",
      targetTrustTier: "verified",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.scope).toEqual({ from: "agent", to: "zone" });
    expect(result.value.changes.trustTier).toEqual({ from: "sandbox", to: "verified" });
  });

  // --- Input validation ---

  test("rejects null input", async () => {
    const tool = createPromoteForgeTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects missing brickId", async () => {
    const tool = createPromoteForgeTool(createDeps());
    const result = (await tool.execute({ targetScope: "zone" })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("brickId");
  });

  test("rejects when no promotion target specified", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("at least one");
  });

  test("rejects invalid scope value", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "invalid_scope",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("INVALID_TYPE");
  });

  test("rejects invalid trust tier value", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetTrustTier: "invalid_tier",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("INVALID_TYPE");
  });

  // --- Store failures ---

  test("returns error when brick does not exist", async () => {
    const tool = createPromoteForgeTool(createDeps());
    const result = (await tool.execute({
      brickId: "brick_nonexistent",
      targetScope: "zone",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("LOAD_FAILED");
  });

  test("returns error when store update fails", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_1", trustTier: "sandbox" }));

    const failingUpdateStore = {
      ...store,
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
    };

    const tool = createPromoteForgeTool(createDeps({ store: failingUpdateStore }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetTrustTier: "verified",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("SAVE_FAILED");
  });

  // --- Governance ---

  test("rejects when forge is disabled", async () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const tool = createPromoteForgeTool(createDeps({ config }));
    const result = (await tool.execute({
      brickId: "brick_1",
      targetScope: "zone",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("FORGE_DISABLED");
  });
});
