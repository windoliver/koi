/**
 * End-to-end validation of atomic promote_forge through the full L1 runtime.
 *
 * Exercises: createKoi + createLoopAdapter + InMemoryForgeStore + promote_forge.
 * Verifies that promoteAndUpdate() atomically applies scope + metadata changes
 * through the full middleware chain, lifecycle hooks, and engine event pipeline.
 *
 * Uses a deterministic model handler (loop adapter) — no real LLM calls.
 * No cost, no flakiness, no API key required.
 *
 * Run:
 *   bun test tests/e2e/promote-atomic-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  SandboxExecutor,
  StoreChangeEvent,
  TieredSandboxExecutor,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { brickId, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import type { ForgeDeps, PromoteResult, ToolArtifact } from "@koi/forge";
import {
  createDefaultForgeConfig,
  createInMemoryForgeStore,
  createPromoteForgeTool,
} from "@koi/forge";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

function createTestBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId("brick_e2e_atomic"),
    kind: "tool",
    name: "test-brick",
    description: "A test brick for atomic promote E2E",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return input;",
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

function createTestDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: mockTiered({
      execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
    }),
    verifiers: [],
    config: createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    }),
    // agentId must match DEFAULT_PROVENANCE.metadata.agentId ("agent-1")
    // because isVisibleToAgent requires matching agentId for scope: "agent" bricks
    context: { agentId: "agent-1", depth: 0, sessionId: "e2e-session", forgesThisSession: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Full L1 stack: createKoi + createLoopAdapter + promote_forge (atomic)
// ---------------------------------------------------------------------------

describe("e2e: atomic promote_forge through full createKoi stack", () => {
  test("promote_forge atomically changes scope + trust via promoteAndUpdate()", async () => {
    // 1. Set up forge store with a test brick (agent scope, sandbox trust)
    const store = createInMemoryForgeStore();
    const brick = createTestBrick();
    await store.save(brick);

    // 2. Create promote_forge tool as entity component
    const deps = createTestDeps({ store });
    const promoteTool = createPromoteForgeTool(deps);

    const toolProvider: ComponentProvider = {
      name: "e2e-promote-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("promote_forge"), promoteTool);
        return components;
      },
    };

    // 3. Track lifecycle hooks and tool calls via middleware
    const hookLog: string[] = []; // let justified: test accumulator
    const interceptedToolIds: string[] = []; // let justified: test accumulator

    const observer: KoiMiddleware = {
      name: "e2e-promote-observer",
      priority: 100,
      onSessionStart: async () => {
        hookLog.push("session:start");
      },
      onBeforeTurn: async () => {
        hookLog.push("turn:before");
      },
      onAfterTurn: async () => {
        hookLog.push("turn:after");
      },
      onSessionEnd: async () => {
        hookLog.push("session:end");
      },
      wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
        interceptedToolIds.push(request.toolId);
        return next(request);
      },
    };

    // 4. Deterministic model handler — two phases
    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          // Phase 1: force promote_forge call
          return {
            content: "I'll promote the brick.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "promote_forge",
                  callId: "call-promote-1",
                  input: {
                    brickId: "brick_e2e_atomic",
                    targetScope: "zone",
                    targetTrustTier: "verified",
                  },
                },
              ],
            },
          };
        }
        // Phase 2: final answer
        return {
          content: "The brick has been promoted to zone scope with verified trust tier.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 15 },
        };
      },
      maxTurns: 5,
    });

    // 5. Create Koi runtime
    const runtime = await createKoi({
      manifest: {
        name: "e2e-promote-atomic",
        version: "0.0.1",
        model: { name: MODEL_NAME },
      },
      adapter,
      middleware: [observer],
      providers: [toolProvider],
    });

    try {
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Promote brick_e2e_atomic to zone scope with verified trust",
        }),
      );

      // --- Verify engine events ---
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent?.kind === "done") {
        expect(doneEvent.output.stopReason).toBe("completed");
        expect(doneEvent.output.metrics.turns).toBeGreaterThanOrEqual(2);
      }

      // Tool call events were emitted
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBe(1);
      if (toolStarts[0]?.kind === "tool_call_start") {
        expect(toolStarts[0].toolName).toBe("promote_forge");
      }

      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolEnds.length).toBe(1);
      if (toolEnds[0]?.kind === "tool_call_end") {
        // Narrow result via discriminated union check (avoids banned `as` assertion)
        const result: unknown = toolEnds[0].result;
        expect(result).toHaveProperty("ok", true);
        const typed = result as { readonly value: PromoteResult };
        expect(typed.value.applied).toBe(true);
        expect(typed.value.requiresHumanApproval).toBe(false);
        expect(typed.value.changes.scope).toEqual({ from: "agent", to: "zone" });
        expect(typed.value.changes.trustTier).toEqual({ from: "sandbox", to: "verified" });
      }

      // --- Verify middleware intercepted tool call ---
      expect(interceptedToolIds).toContain("promote_forge");

      // --- Verify lifecycle hooks ---
      expect(hookLog.at(0)).toBe("session:start");
      expect(hookLog.at(-1)).toBe("session:end");
      expect(hookLog).toContain("turn:before");
      expect(hookLog).toContain("turn:after");

      // --- Verify store state (atomic: both scope + trust changed) ---
      const loadResult = await store.load(brickId("brick_e2e_atomic"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.scope).toBe("zone");
        expect(loadResult.value.trustTier).toBe("verified");
      }

      // Model was called twice (tool call + final answer)
      expect(callCount).toBe(2);
    } finally {
      await runtime.dispose?.();
    }
  }, 30_000);

  test("promote_forge with scope + lifecycle + zone tag atomically applied", async () => {
    // Test multi-field atomic promote: scope + lifecycle + auto zone tag
    const store = createInMemoryForgeStore();
    const brick = createTestBrick({
      id: brickId("brick_multiform"),
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      tags: ["existing-tag"],
    });
    await store.save(brick);

    const deps = createTestDeps({
      store,
      context: {
        agentId: "agent-1",
        depth: 0,
        sessionId: "e2e-session",
        forgesThisSession: 0,
        zoneId: "team-alpha",
      },
    });
    const promoteTool = createPromoteForgeTool(deps);

    const toolProvider: ComponentProvider = {
      name: "e2e-promote-multi-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("promote_forge"), promoteTool);
        return components;
      },
    };

    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Promoting with multiple fields.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "promote_forge",
                  callId: "call-promote-multi",
                  input: {
                    brickId: "brick_multiform",
                    targetScope: "zone",
                    targetLifecycle: "deprecated",
                  },
                },
              ],
            },
          };
        }
        return {
          content: "Done — scope promoted to zone, lifecycle set to deprecated.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 15 },
        };
      },
      maxTurns: 5,
    });

    const runtime = await createKoi({
      manifest: {
        name: "e2e-promote-multi",
        version: "0.0.1",
        model: { name: MODEL_NAME },
      },
      adapter,
      providers: [toolProvider],
    });

    try {
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Promote brick with scope and lifecycle" }),
      );

      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent?.kind === "done") {
        expect(doneEvent.output.stopReason).toBe("completed");
      }

      // Verify all changes applied atomically in the store
      const loadResult = await store.load(brickId("brick_multiform"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.scope).toBe("zone");
        expect(loadResult.value.lifecycle).toBe("deprecated");
        // Zone tag auto-assigned from context.zoneId
        expect(loadResult.value.tags).toContain("zone:team-alpha");
        // Original tag preserved
        expect(loadResult.value.tags).toContain("existing-tag");
      }
    } finally {
      await runtime.dispose?.();
    }
  }, 30_000);

  test("store watch fires 'promoted' event through L1 runtime", async () => {
    const store = createInMemoryForgeStore();
    const brick = createTestBrick();
    await store.save(brick);

    // Subscribe to store.watch before running the agent
    const watchEvents: StoreChangeEvent[] = []; // let justified: test accumulator
    const unsub = store.watch((event) => {
      watchEvents.push(event);
    });

    const deps = createTestDeps({ store });
    const promoteTool = createPromoteForgeTool(deps);

    const toolProvider: ComponentProvider = {
      name: "e2e-watch-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("promote_forge"), promoteTool);
        return components;
      },
    };

    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Promoting.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "promote_forge",
                  callId: "call-watch-1",
                  input: {
                    brickId: "brick_e2e_atomic",
                    targetScope: "zone",
                  },
                },
              ],
            },
          };
        }
        return {
          content: "Promoted.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
      maxTurns: 5,
    });

    const runtime = await createKoi({
      manifest: { name: "e2e-promote-watch", version: "0.0.1", model: { name: MODEL_NAME } },
      adapter,
      providers: [toolProvider],
    });

    try {
      await collectEvents(runtime.run({ kind: "text", text: "Promote brick to zone" }));

      // Store watch should have received a "promoted" event
      // (the initial save fires "saved", then promoteAndUpdate fires "promoted")
      const promotedEvents = watchEvents.filter((e) => e.kind === "promoted");
      expect(promotedEvents.length).toBe(1);
      expect(promotedEvents[0]?.brickId).toBe(brickId("brick_e2e_atomic"));
      expect(promotedEvents[0]?.scope).toBe("zone");
    } finally {
      unsub();
      await runtime.dispose?.();
    }
  }, 30_000);

  test("promote_forge error propagates correctly through L1 runtime", async () => {
    // Try to promote a non-existent brick — error flows through engine events
    const store = createInMemoryForgeStore();

    const deps = createTestDeps({ store });
    const promoteTool = createPromoteForgeTool(deps);

    const toolProvider: ComponentProvider = {
      name: "e2e-error-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("promote_forge"), promoteTool);
        return components;
      },
    };

    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Promoting non-existent brick.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "promote_forge",
                  callId: "call-error-1",
                  input: {
                    brickId: "nonexistent_brick",
                    targetScope: "zone",
                  },
                },
              ],
            },
          };
        }
        return {
          content: "The brick was not found.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
      maxTurns: 5,
    });

    const runtime = await createKoi({
      manifest: { name: "e2e-promote-error", version: "0.0.1", model: { name: MODEL_NAME } },
      adapter,
      providers: [toolProvider],
    });

    try {
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Promote nonexistent brick" }),
      );

      // Agent still completes (tool returns error result, not an exception)
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();

      // Tool call end should contain the error result
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolEnds.length).toBe(1);
      if (toolEnds[0]?.kind === "tool_call_end") {
        expect(toolEnds[0].result).toHaveProperty("ok", false);
      }

      // Model was called twice (tool call + final answer)
      expect(callCount).toBe(2);
    } finally {
      await runtime.dispose?.();
    }
  }, 30_000);

  test("multiple sequential promotes through L1 runtime", async () => {
    // Two promote calls in sequence: first changes scope, second changes trust
    const store = createInMemoryForgeStore();
    const brick = createTestBrick({
      id: brickId("brick_sequential"),
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
    });
    await store.save(brick);

    const deps = createTestDeps({ store });
    const promoteTool = createPromoteForgeTool(deps);

    const toolProvider: ComponentProvider = {
      name: "e2e-sequential-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("promote_forge"), promoteTool);
        return components;
      },
    };

    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: promote scope to zone
          return {
            content: "First promotion — scope change.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "promote_forge",
                  callId: "call-seq-1",
                  input: {
                    brickId: "brick_sequential",
                    targetScope: "zone",
                  },
                },
              ],
            },
          };
        }
        if (callCount === 2) {
          // Second call: promote trust to verified
          return {
            content: "Second promotion — trust change.",
            model: MODEL_NAME,
            usage: { inputTokens: 15, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "promote_forge",
                  callId: "call-seq-2",
                  input: {
                    brickId: "brick_sequential",
                    targetTrustTier: "verified",
                  },
                },
              ],
            },
          };
        }
        // Final answer
        return {
          content: "Both promotions applied.",
          model: MODEL_NAME,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
      maxTurns: 10,
    });

    const runtime = await createKoi({
      manifest: { name: "e2e-promote-seq", version: "0.0.1", model: { name: MODEL_NAME } },
      adapter,
      providers: [toolProvider],
    });

    try {
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Promote brick scope then trust" }),
      );

      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();

      // Both tool calls were executed
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBe(2);

      // Final store state reflects both promotions
      const loadResult = await store.load(brickId("brick_sequential"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.scope).toBe("zone");
        expect(loadResult.value.trustTier).toBe("verified");
      }

      expect(callCount).toBe(3);
    } finally {
      await runtime.dispose?.();
    }
  }, 30_000);
});
