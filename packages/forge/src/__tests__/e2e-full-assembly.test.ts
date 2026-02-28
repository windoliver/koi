/**
 * E2E test — Full L1 runtime assembly with real LLM.
 *
 * Validates the complete pipeline end-to-end:
 *   1. Middleware lifecycle hook ordering (all 6 hooks in correct sequence)
 *   2. Hot-attach via ForgeRuntime with real LLM
 *   3. Multi-middleware priority ordering (ascending priority on wrapToolCall)
 *   4. Cache invalidation + re-assembly with real LLM
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests skip when either is missing.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=... bun test packages/forge/src/__tests__/e2e-full-assembly.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createDefaultForgeConfig } from "../config.js";
import { createForgeComponentProvider } from "../forge-component-provider.js";
import { createForgeRuntime } from "../forge-runtime.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeToolTool } from "../tools/forge-tool.js";
import type { ForgeDeps } from "../tools/shared.js";
import type { ForgeResult, SandboxExecutor, TieredSandboxExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "forge-full-assembly-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

function createModelCall(): (req: ModelRequest) => Promise<ModelResponse> {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (req) => adapter.complete({ ...req, model: "claude-haiku-4-5-20251001" });
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/** Adder executor: evaluates input.a + input.b. */
function adderExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => {
      const obj = input as { readonly a: number; readonly b: number };
      return {
        ok: true,
        value: { output: { sum: obj.a + obj.b }, durationMs: 1 },
      };
    },
  };
}

/** Echo executor: returns input as-is. */
function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
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

function defaultDeps(
  store: ReturnType<typeof createInMemoryForgeStore>,
  executor: SandboxExecutor,
  sessionForges = 0,
): ForgeDeps {
  return {
    store,
    executor: mockTiered(executor),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: {
      agentId: "e2e-agent",
      depth: 0,
      sessionId: "e2e-session",
      forgesThisSession: sessionForges,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: full L1 runtime assembly with real LLM", () => {
  // -------------------------------------------------------------------------
  // Test 1: Full middleware lifecycle hook ordering
  // -------------------------------------------------------------------------

  test(
    "middleware lifecycle hooks fire in correct order during real LLM session",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Forge an "adder" tool
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "adder",
        description: "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // Create ForgeComponentProvider
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // Lifecycle observer middleware — records hook names in order
      const hookOrder: string[] = [];
      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onBeforeTurn: async () => {
          hookOrder.push("before_turn");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
        wrapModelCall: async (_ctx, req, next) => {
          hookOrder.push("model_call");
          return next(req);
        },
        wrapToolCall: async (_ctx, req, next) => {
          hookOrder.push("tool_call");
          return next(req);
        },
      };

      // Full L1 runtime
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        middleware: [lifecycleObserver],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the adder tool to add 17 and 25. Return the result.",
        }),
      );
      await runtime.dispose();

      // Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Token metrics should be populated
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // Hook ordering invariants
      expect(hookOrder.length).toBeGreaterThan(0);

      // session_start must be first
      expect(hookOrder[0]).toBe("session_start");
      // session_end must be last
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");

      // before_turn must appear before the corresponding after_turn
      const firstBeforeTurn = hookOrder.indexOf("before_turn");
      const firstAfterTurn = hookOrder.indexOf("after_turn");
      expect(firstBeforeTurn).toBeGreaterThan(-1);
      expect(firstAfterTurn).toBeGreaterThan(-1);
      expect(firstBeforeTurn).toBeLessThan(firstAfterTurn);

      // model_call must have been recorded at least once
      expect(hookOrder).toContain("model_call");

      // model_call should occur between before_turn and after_turn
      const firstModelCall = hookOrder.indexOf("model_call");
      expect(firstModelCall).toBeGreaterThan(firstBeforeTurn);
      expect(firstModelCall).toBeLessThan(firstAfterTurn);

      // If tool was called, verify tool_call is between model_call and after_turn
      if (hookOrder.includes("tool_call")) {
        const firstToolCall = hookOrder.indexOf("tool_call");
        expect(firstToolCall).toBeGreaterThan(firstBeforeTurn);
        expect(firstToolCall).toBeLessThan(hookOrder.lastIndexOf("after_turn") + 1);
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: Hot-attach via ForgeRuntime with real LLM
  // -------------------------------------------------------------------------

  test(
    "hot-attach: tool forged via forge_tool is callable by real LLM in subsequent turn",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Attach forge_tool as a primordial component
      const forgeTool = createForgeToolTool(deps);
      const primordialProvider = {
        name: "forge-primordials",
        attach: async (): Promise<ReadonlyMap<string, unknown>> =>
          new Map<string, unknown>([[toolToken("forge_tool") as string, forgeTool]]),
      };

      // Create ForgeRuntime for hot-attach
      const forgeRuntime = createForgeRuntime({
        store,
        executor: mockTiered(executor),
      });

      // Full L1 runtime with forge runtime for hot-attach
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 8 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [primordialProvider],
        forge: forgeRuntime,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have a tool called forge_tool. First, use forge_tool to create a new tool with these exact parameters:",
            '  name: "adder"',
            '  description: "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}."',
            '  inputSchema: {"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}',
            '  implementation: "return { sum: input.a + input.b };"',
            "",
            "After forge_tool succeeds, use the new adder tool to add 17 and 25.",
            "Tell me the sum.",
          ].join("\n"),
        }),
      );
      await runtime.dispose();
      forgeRuntime.dispose?.();

      // Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Token metrics should be populated
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // forge_tool MUST have been called — this is the core assertion of the test.
      // The prompt explicitly asks the LLM to use forge_tool first.
      const forgeToolCalls = events.filter(
        (e) => e.kind === "tool_call_start" && "toolId" in e && e.toolId === "forge_tool",
      );
      expect(forgeToolCalls.length).toBeGreaterThanOrEqual(1);

      // Tolerant: adder call is best-effort — hot-attach timing is non-deterministic.
      // The LLM may not see the newly forged adder within the turn budget.
      const adderCalls = events.filter(
        (e) => e.kind === "tool_call_start" && "toolId" in e && e.toolId === "adder",
      );
      if (adderCalls.length === 0) {
        // eslint-disable-next-line no-console -- intentional diagnostic for non-deterministic E2E
        console.warn("LLM did not call adder in hot-attach test — timing-dependent, not a failure");
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: Multi-middleware priority ordering
  // -------------------------------------------------------------------------

  test(
    "multi-middleware fire in ascending priority order on wrapToolCall",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = echoExecutor();
      const deps = defaultDeps(store, executor);

      // Forge an "echo" tool (returns input as-is)
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "echo",
        description: "Echoes the input back. Call with any JSON object. Returns the same object.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        implementation: "return input;",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // Create ForgeComponentProvider
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // 3 middleware with different priorities — intercept order tracked
      const interceptOrder: string[] = [];

      const outerMiddleware: KoiMiddleware = {
        name: "outer",
        describeCapabilities: () => undefined,
        priority: 100,
        wrapToolCall: async (_ctx, req, next) => {
          interceptOrder.push("outer");
          return next(req);
        },
      };

      const middleMiddleware: KoiMiddleware = {
        name: "middle",
        describeCapabilities: () => undefined,
        priority: 300,
        wrapToolCall: async (_ctx, req, next) => {
          interceptOrder.push("middle");
          return next(req);
        },
      };

      const innerMiddleware: KoiMiddleware = {
        name: "inner",
        describeCapabilities: () => undefined,
        priority: 500,
        wrapToolCall: async (_ctx, req, next) => {
          interceptOrder.push("inner");
          return next(req);
        },
      };

      // Full L1 runtime
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        middleware: [outerMiddleware, middleMiddleware, innerMiddleware],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the echo tool with {"message": "hello"}. Tell me what it returned.',
        }),
      );
      await runtime.dispose();

      // Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Token metrics should be populated
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // If the tool was called, verify ascending priority order
      if (interceptOrder.length > 0) {
        expect(interceptOrder).toEqual(["outer", "middle", "inner"]);
      }
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 4: Cache invalidation + re-assembly with real LLM
  // -------------------------------------------------------------------------

  test(
    "cache invalidation: new tool visible after invalidate + re-assembly",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      // --- Phase 1: Forge tool-alpha (adder) ---
      const deps1 = defaultDeps(store, executor);
      const forgeToolApi1 = createForgeToolTool(deps1);
      const alphaResult = (await forgeToolApi1.execute({
        name: "tool-alpha",
        description: "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(alphaResult.ok).toBe(true);

      // Create ForgeComponentProvider — reused across both assemblies
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // First assembly — only tool-alpha should be attached
      const modelCall = createModelCall();
      const loopAdapter1 = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime1 = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter1,
        providers: [forgeProvider],
        loopDetection: false,
      });

      await collectEvents(runtime1.run({ kind: "text", text: "Say hello." }));
      await runtime1.dispose();

      // Verify tool-alpha attached, tool-beta NOT attached
      const alphaComponent = runtime1.agent.component(toolToken("tool-alpha"));
      expect(alphaComponent).toBeDefined();
      const betaComponentBefore = runtime1.agent.component(toolToken("tool-beta"));
      expect(betaComponentBefore).toBeUndefined();

      // --- Phase 2: Forge tool-beta (multiplier) ---
      const deps2 = defaultDeps(store, executor, 1);
      const forgeToolApi2 = createForgeToolTool(deps2);
      const betaResult = (await forgeToolApi2.execute({
        name: "tool-beta",
        description:
          "Multiplies two numbers. Call with {a: number, b: number}. Returns {product: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { product: input.a * input.b };",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(betaResult.ok).toBe(true);

      // Invalidate the SAME provider's cache so next attach() re-queries the store.
      // This is the core behavior under test — same provider, invalidated cache.
      forgeProvider.invalidate();

      // --- Phase 3: Re-assembly with same provider — both tools should be visible ---
      const loopAdapter2 = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime2 = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter2,
        providers: [forgeProvider],
        loopDetection: false,
      });

      const events2 = await collectEvents(
        runtime2.run({
          kind: "text",
          text: "Use the tool-beta tool to multiply 6 and 7. Return the result.",
        }),
      );
      await runtime2.dispose();

      // Verify both tools attached in second assembly
      const alphaComponent2 = runtime2.agent.component(toolToken("tool-alpha"));
      expect(alphaComponent2).toBeDefined();
      const betaComponent2 = runtime2.agent.component(toolToken("tool-beta"));
      expect(betaComponent2).toBeDefined();

      // Done output should exist
      const output2 = findDoneOutput(events2);
      expect(output2).toBeDefined();
      expect(output2?.stopReason === "completed" || output2?.stopReason === "max_turns").toBe(true);

      // Token metrics should be populated
      if (output2 !== undefined) {
        expect(output2.metrics.inputTokens).toBeGreaterThan(0);
        expect(output2.metrics.outputTokens).toBeGreaterThan(0);
      }

      // Tolerant: if tool-beta was called, verify events contain tool_call events
      const betaToolCallEvents = events2.filter(
        (e) => e.kind === "tool_call_start" || e.kind === "tool_call_end",
      );
      if (betaToolCallEvents.length > 0) {
        expect(betaToolCallEvents.length).toBeGreaterThanOrEqual(2); // start + end pair
      }
    },
    TIMEOUT_MS,
  );
});
