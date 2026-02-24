import { describe, expect, test } from "bun:test";
import type {
  BrickLifecycle,
  SandboxExecutor,
  StoreChangeEvent,
  TieredSandboxExecutor,
} from "@koi/core";
import { VALID_LIFECYCLE_TRANSITIONS } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createMemoryStoreChangeNotifier } from "../store-notifier.js";
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

function createDeps(
  overrides?: Partial<ForgeDeps> & { readonly notifier?: ForgeDeps["notifier"] },
): ForgeDeps {
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

  test("rejects trust tier demotion with dedicated error code", async () => {
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
    expect(result.error.code).toBe("TRUST_DEMOTION_NOT_ALLOWED");
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

  // --- Lifecycle transitions (Issue 7A: VALID_LIFECYCLE_TRANSITIONS enforcement) ---

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

  test("rejects transition from failed with LIFECYCLE_INVALID_TRANSITION code", async () => {
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
    expect(result.error.code).toBe("LIFECYCLE_INVALID_TRANSITION");
    expect(result.error.message).toContain("failed");
  });

  // --- Lifecycle transition matrix (Issue 11A) ---
  // Exhaustive test of all valid and invalid transitions

  describe("lifecycle transition matrix", () => {
    const ALL_STATES: readonly BrickLifecycle[] = [
      "draft",
      "verifying",
      "active",
      "failed",
      "deprecated",
      "quarantined",
    ];

    for (const from of ALL_STATES) {
      const allowed = VALID_LIFECYCLE_TRANSITIONS[from];
      for (const to of ALL_STATES) {
        if (from === to) continue; // same-state is a no-op, tested elsewhere
        const shouldSucceed = allowed.includes(to);

        test(`${from} → ${to}: ${shouldSucceed ? "allowed" : "rejected"}`, async () => {
          const store = createInMemoryForgeStore();
          await store.save(createToolBrick({ id: "brick_lc", lifecycle: from }));

          const tool = createPromoteForgeTool(createDeps({ store }));
          const result = (await tool.execute({
            brickId: "brick_lc",
            targetLifecycle: to,
          })) as {
            readonly ok: boolean;
            readonly value?: PromoteResult;
            readonly error?: { readonly code: string };
          };

          if (shouldSucceed) {
            expect(result.ok).toBe(true);
            expect(result.value?.changes.lifecycle).toEqual({ from, to });
          } else {
            expect(result.ok).toBe(false);
            expect(result.error?.code).toBe("LIFECYCLE_INVALID_TRANSITION");
          }
        });
      }
    }
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

  // --- Per-field HITL (Issue 5A) ---

  test("scope HITL does not block trust and lifecycle changes", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "brick_hitl",
        scope: "agent",
        trustTier: "sandbox",
        lifecycle: "active",
      }),
    );

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: true,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "sandbox",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_hitl",
      targetScope: "zone",
      targetTrustTier: "verified",
      targetLifecycle: "deprecated",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    // Scope is HITL-gated, but trust + lifecycle should still apply
    expect(result.value.requiresHumanApproval).toBe(true);
    expect(result.value.applied).toBe(true); // trust + lifecycle applied
    expect(result.value.changes.scope).toEqual({ from: "agent", to: "zone" });
    expect(result.value.changes.trustTier).toEqual({ from: "sandbox", to: "verified" });
    expect(result.value.changes.lifecycle).toEqual({ from: "active", to: "deprecated" });

    // Verify trust and lifecycle were updated in store, but scope was NOT
    const loadResult = await store.load("brick_hitl");
    if (loadResult.ok) {
      expect(loadResult.value.scope).toBe("agent"); // NOT promoted (HITL pending)
      expect(loadResult.value.trustTier).toBe("verified"); // applied
      expect(loadResult.value.lifecycle).toBe("deprecated"); // applied
    }
  });

  // --- Mixed-dimension promotion tests (Issue 9A) ---

  test("applies all three dimensions: scope + trust + lifecycle", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "brick_3d",
        scope: "agent",
        trustTier: "sandbox",
        lifecycle: "draft",
      }),
    );

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_3d",
      targetScope: "zone",
      targetTrustTier: "verified",
      targetLifecycle: "verifying",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.changes.scope).toEqual({ from: "agent", to: "zone" });
    expect(result.value.changes.trustTier).toEqual({ from: "sandbox", to: "verified" });
    expect(result.value.changes.lifecycle).toEqual({ from: "draft", to: "verifying" });
  });

  test("trust demotion fails independently of valid scope/lifecycle", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "brick_mixed",
        scope: "agent",
        trustTier: "verified",
        lifecycle: "active",
      }),
    );

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_mixed",
      targetScope: "zone",
      targetTrustTier: "sandbox", // demotion — should fail
      targetLifecycle: "deprecated",
    })) as {
      readonly ok: false;
      readonly error: { readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TRUST_DEMOTION_NOT_ALLOWED");
  });

  test("invalid lifecycle fails independently of valid scope/trust", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "brick_mixed2",
        scope: "agent",
        trustTier: "sandbox",
        lifecycle: "failed",
      }),
    );

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store, config }));

    const result = (await tool.execute({
      brickId: "brick_mixed2",
      targetScope: "zone",
      targetTrustTier: "verified",
      targetLifecycle: "active", // invalid from "failed"
    })) as {
      readonly ok: false;
      readonly error: { readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("LIFECYCLE_INVALID_TRANSITION");
  });

  // --- Wire to store.promote() (Issue 1A) ---

  test("calls store.promote() for scope changes when available", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_wire", scope: "agent", trustTier: "verified" }));

    let promoteCalled = false;
    let promoteArgs: { id: string; scope: string } | undefined;
    const storeWithPromote = {
      ...store,
      promote: async (id: string, targetScope: string) => {
        promoteCalled = true;
        promoteArgs = { id, scope: targetScope };
        // Just update the scope in the underlying store
        return store.update(id, { scope: targetScope as "agent" | "zone" | "global" });
      },
    };

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store: storeWithPromote, config }));

    const result = (await tool.execute({
      brickId: "brick_wire",
      targetScope: "zone",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(promoteCalled).toBe(true);
    expect(promoteArgs).toEqual({ id: "brick_wire", scope: "zone" });
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
    expect(result.error.code).toBe("INVALID_SCHEMA");
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
    expect(result.error.code).toBe("INVALID_SCHEMA");
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

  test("returns SAVE_FAILED when store.promote() fails", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: "brick_prfail", scope: "agent", trustTier: "verified" }),
    );

    const failingPromoteStore = {
      ...store,
      promote: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "promote disk error", retryable: false },
      }),
    };

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store: failingPromoteStore, config }));
    const result = (await tool.execute({
      brickId: "brick_prfail",
      targetScope: "zone",
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

  // -------------------------------------------------------------------------
  // Zone tag auto-assignment (Issue C2)
  // -------------------------------------------------------------------------

  test("auto-assigns zone tag when promoting to zone scope with zoneId", async () => {
    const deps = createDeps({
      config: createDefaultForgeConfig({
        scopePromotion: {
          requireHumanApproval: false,
          minTrustForZone: "sandbox",
          minTrustForGlobal: "promoted",
        },
      }),
      context: {
        agentId: "agent-1",
        depth: 0,
        sessionId: "session-1",
        forgesThisSession: 0,
        zoneId: "team-alpha",
      },
    });

    const brick = createToolBrick({ id: "brick_zone_tag", tags: ["existing"] });
    await deps.store.save(brick);

    const tool = createPromoteForgeTool(deps);
    const result = (await tool.execute({
      brickId: "brick_zone_tag",
      targetScope: "zone",
    })) as { readonly ok: boolean; readonly value?: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value?.applied).toBe(true);

    // Verify the brick now has the zone tag
    const loaded = await deps.store.load("brick_zone_tag");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.tags).toContain("zone:team-alpha");
      expect(loaded.value.tags).toContain("existing");
    }
  });

  test("does not add duplicate zone tag if already present", async () => {
    const deps = createDeps({
      config: createDefaultForgeConfig({
        scopePromotion: {
          requireHumanApproval: false,
          minTrustForZone: "sandbox",
          minTrustForGlobal: "promoted",
        },
      }),
      context: {
        agentId: "agent-1",
        depth: 0,
        sessionId: "session-1",
        forgesThisSession: 0,
        zoneId: "team-alpha",
      },
    });

    const brick = createToolBrick({
      id: "brick_dup_tag",
      tags: ["zone:team-alpha"],
    });
    await deps.store.save(brick);

    const tool = createPromoteForgeTool(deps);
    const result = (await tool.execute({
      brickId: "brick_dup_tag",
      targetScope: "zone",
    })) as { readonly ok: boolean; readonly value?: PromoteResult };

    expect(result.ok).toBe(true);

    // Verify no duplicate tag
    const loaded = await deps.store.load("brick_dup_tag");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const zoneTags = loaded.value.tags.filter((t) => t === "zone:team-alpha");
      expect(zoneTags.length).toBe(1);
    }
  });

  test("does not assign zone tag when zoneId is not set", async () => {
    const deps = createDeps({
      config: createDefaultForgeConfig({
        scopePromotion: {
          requireHumanApproval: false,
          minTrustForZone: "sandbox",
          minTrustForGlobal: "promoted",
        },
      }),
      // no zoneId in context
    });

    const brick = createToolBrick({ id: "brick_no_zone", tags: [] });
    await deps.store.save(brick);

    const tool = createPromoteForgeTool(deps);
    await tool.execute({
      brickId: "brick_no_zone",
      targetScope: "zone",
    });

    const loaded = await deps.store.load("brick_no_zone");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.tags.length).toBe(0);
    }
  });

  test("does not assign zone tag when promoting to global scope", async () => {
    const deps = createDeps({
      config: createDefaultForgeConfig({
        scopePromotion: {
          requireHumanApproval: false,
          minTrustForZone: "sandbox",
          minTrustForGlobal: "sandbox",
        },
      }),
      context: {
        agentId: "agent-1",
        depth: 0,
        sessionId: "session-1",
        forgesThisSession: 0,
        zoneId: "team-alpha",
      },
    });

    const brick = createToolBrick({ id: "brick_global_no_tag", tags: [] });
    await deps.store.save(brick);

    const tool = createPromoteForgeTool(deps);
    await tool.execute({
      brickId: "brick_global_no_tag",
      targetScope: "global",
    });

    const loaded = await deps.store.load("brick_global_no_tag");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.tags.length).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Notifier integration (fire-and-forget events after mutations)
  // -------------------------------------------------------------------------

  test("fires 'promoted' notification when store.promote() is used", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: "brick_notify", scope: "agent", trustTier: "verified" }),
    );

    const notifier = createMemoryStoreChangeNotifier();
    const events: StoreChangeEvent[] = [];
    notifier.subscribe((event) => events.push(event));

    const storeWithPromote = {
      ...store,
      promote: async (id: string, targetScope: string) => {
        return store.update(id, { scope: targetScope as "agent" | "zone" | "global" });
      },
    };

    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const tool = createPromoteForgeTool(createDeps({ store: storeWithPromote, config, notifier }));

    const result = (await tool.execute({
      brickId: "brick_notify",
      targetScope: "zone",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);

    // Allow fire-and-forget to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("promoted");
    expect(events[0]?.brickId).toBe("brick_notify");
    expect(events[0]?.scope).toBe("zone");
  });

  test("fires 'updated' notification when store.promote() is not available", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_upd_notify", trustTier: "sandbox" }));

    const notifier = createMemoryStoreChangeNotifier();
    const events: StoreChangeEvent[] = [];
    notifier.subscribe((event) => events.push(event));

    const tool = createPromoteForgeTool(createDeps({ store, notifier }));

    const result = (await tool.execute({
      brickId: "brick_upd_notify",
      targetTrustTier: "verified",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("updated");
    expect(events[0]?.brickId).toBe("brick_upd_notify");
  });

  test("does not fire notification when no changes are made", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_noop", scope: "agent" }));

    const notifier = createMemoryStoreChangeNotifier();
    const events: StoreChangeEvent[] = [];
    notifier.subscribe((event) => events.push(event));

    const tool = createPromoteForgeTool(createDeps({ store, notifier }));

    // Same scope — no-op
    await tool.execute({
      brickId: "brick_noop",
      targetScope: "agent",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events.length).toBe(0);
  });

  test("no notification when notifier is not provided", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_no_notifier", trustTier: "sandbox" }));

    // No notifier — should not throw
    const tool = createPromoteForgeTool(createDeps({ store }));

    const result = (await tool.execute({
      brickId: "brick_no_notifier",
      targetTrustTier: "verified",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
  });

  test("rejects promoting another agent's agent-scoped brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: "brick_foreign", createdBy: "agent-2", scope: "agent" }),
    );

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_foreign",
      targetTrustTier: "verified",
    })) as { readonly ok: false; readonly error: { readonly code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("LOAD_FAILED");
  });

  test("allows promoting own agent-scoped brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_own", createdBy: "agent-1", scope: "agent" }));

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_own",
      targetTrustTier: "verified",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
    expect(result.value.changes.trustTier).toBeDefined();
  });

  test("allows promoting another agent's global-scoped brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: "brick_global", createdBy: "agent-2", scope: "global" }),
    );

    const tool = createPromoteForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      brickId: "brick_global",
      targetTrustTier: "verified",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(result.ok).toBe(true);
  });
});
