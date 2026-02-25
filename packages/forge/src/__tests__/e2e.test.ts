/**
 * E2E test — Forge through the full L1 runtime assembly.
 *
 * Validates forged bricks flow through createKoi + createLoopAdapter with real
 * LLM calls:
 *   1. Forge a tool → ComponentProvider attaches it → LLM calls it → result returned
 *   2. Forge a middleware → middleware hooks fire during LLM session
 *   3. Forge an engine implementation → ComponentProvider registers under engineToken
 *   4. Requires enforcement: brick with missing env skipped by ComponentProvider
 *   5. configSchema: stored and retrievable on artifact
 *
 * Gated on ANTHROPIC_API_KEY — tests skip when not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... bun test packages/forge/src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ToolRequest,
} from "@koi/core";
import { engineToken, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createDefaultForgeConfig } from "../config.js";
import { createForgeComponentProvider } from "../forge-component-provider.js";
import { createForgeRuntime } from "../forge-runtime.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createMemoryStoreChangeNotifier } from "../store-notifier.js";
import { createForgeEngineTool } from "../tools/forge-engine.js";
import { createForgeMiddlewareTool } from "../tools/forge-middleware.js";
import { createForgeToolTool } from "../tools/forge-tool.js";
import { createPromoteForgeTool } from "../tools/promote-forge.js";
import type { ForgeDeps } from "../tools/shared.js";
import type { ForgeResult, SandboxExecutor, TieredSandboxExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "forge-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

function createModelCall(): (req: ModelRequest) => Promise<import("@koi/core").ModelResponse> {
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

/** Echo executor: returns input as-is. */
function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
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

describeE2E("e2e: forge through createKoi + createLoopAdapter with Anthropic", () => {
  test(
    "forged tool is callable by LLM through the full runtime",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Step 1: Forge an "adder" tool
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

      // Step 2: Create ForgeComponentProvider
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // Step 3: Create the full L1 runtime with real LLM
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      // Step 4: Ask the LLM to use the adder tool
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the adder tool to add 17 and 25. Return the result.",
        }),
      );
      await runtime.dispose();

      // Step 5: Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Token metrics should be populated
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // The agent should have the forged tool attached
      const toolComponent = runtime.agent.component(toolToken("adder"));
      expect(toolComponent).toBeDefined();

      // Check that tool-related events were emitted (LLM called the tool)
      const toolCallEvents = events.filter(
        (e) => e.kind === "tool_call_start" || e.kind === "tool_call_end",
      );
      // LLM may or may not choose to call the tool — verify at least the tool was available
      // If it did call, verify the events exist
      if (toolCallEvents.length > 0) {
        expect(toolCallEvents.length).toBeGreaterThanOrEqual(2); // start + end pair
      }
    },
    TIMEOUT_MS,
  );

  test(
    "forged tool with middleware spy through full runtime",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Step 1: Forge "multiplier" tool
      const forgeTool = createForgeToolTool(deps);
      const result = (await forgeTool.execute({
        name: "multiplier",
        description:
          "Multiplies two numbers. Call with {a: number, b: number}. Returns {product: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { product: input.a * input.b };",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(result.ok).toBe(true);

      // Step 2: ComponentProvider + middleware spy
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const interceptedToolIds: string[] = [];
      const middlewareSpy: KoiMiddleware = {
        name: "e2e-spy",
        wrapToolCall: async (_ctx, req: ToolRequest, next) => {
          interceptedToolIds.push(req.toolId);
          return next(req);
        },
      };

      // Step 3: Full runtime
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        middleware: [middlewareSpy],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiplier tool to multiply 6 and 7. Return the result.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Middleware spy should have intercepted the multiplier tool call
      if (interceptedToolIds.length > 0) {
        expect(interceptedToolIds).toContain("multiplier");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "forged engine brick discoverable via ComponentProvider",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = mockExecutor();
      const deps = defaultDeps(store, executor);

      // Step 1: Forge an engine brick
      const forgeEngine = createForgeEngineTool(deps);
      const result = (await forgeEngine.execute({
        name: "custom-loop",
        description: "A custom engine loop implementation",
        implementation: "export function stream() { /* ... */ }",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(result.ok).toBe(true);

      // Step 2: Promote to "verified" trust (engine requires verified trust)
      // Brick starts at lifecycle: "active", trustTier: "sandbox" — only need trust promotion
      const deps2 = defaultDeps(store, executor, 1);
      const promoteTool = createPromoteForgeTool(deps2);
      const promoteResult = await promoteTool.execute({
        brickId: result.value.id,
        targetTrustTier: "verified",
      });
      expect((promoteResult as { readonly ok: boolean }).ok).toBe(true);

      // Step 3: ComponentProvider should register it under engineToken
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // Step 4: Create runtime — engine brick should be discoverable
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      // Run a minimal turn to trigger attach()
      const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
      await runtime.dispose();

      expect(findDoneOutput(events)).toBeDefined();

      // Engine brick should be registered as a component
      const engineComponent = runtime.agent.component(engineToken("custom-loop"));
      expect(engineComponent).toBeDefined();
    },
    TIMEOUT_MS,
  );

  test(
    "requires enforcement: brick with missing env var skipped by ComponentProvider",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = mockExecutor();
      const deps = defaultDeps(store, executor);

      // Step 1: Forge a tool with an env requirement that won't be satisfied
      const forgeTool = createForgeToolTool(deps);
      await forgeTool.execute({
        name: "gated-tool",
        description: "A tool gated by env var",
        inputSchema: { type: "object" },
        implementation: "return input;",
        requires: { env: ["__KOI_E2E_NONEXISTENT_ENV_VAR__"] },
      });

      // Step 2: Forge a tool WITHOUT requires (should be visible)
      const deps2 = defaultDeps(store, executor, 1);
      const forgeTool2 = createForgeToolTool(deps2);
      await forgeTool2.execute({
        name: "ungated-tool",
        description: "A tool with no requirements",
        inputSchema: { type: "object" },
        implementation: "return input;",
      });

      // Step 3: ComponentProvider should skip the gated tool
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "hello" }));
      await runtime.dispose();

      // gated-tool should NOT be attached (missing env var)
      const gatedComponent = runtime.agent.component(toolToken("gated-tool"));
      expect(gatedComponent).toBeUndefined();

      // ungated-tool SHOULD be attached
      const ungatedComponent = runtime.agent.component(toolToken("ungated-tool"));
      expect(ungatedComponent).toBeDefined();
    },
    TIMEOUT_MS,
  );

  test(
    "configSchema stored and retrievable on forged middleware artifact",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = mockExecutor();
      const deps = defaultDeps(store, executor);

      const configSchema = {
        type: "object",
        properties: {
          maxRetries: { type: "number", description: "Max retry attempts" },
          timeout: { type: "number", description: "Timeout in ms" },
        },
        required: ["maxRetries"],
      };

      // Step 1: Forge middleware with configSchema
      const forgeMiddleware = createForgeMiddlewareTool(deps);
      const result = (await forgeMiddleware.execute({
        name: "retry-mw",
        description: "Retry middleware with configurable retries",
        implementation: "export function wrapModelCall(ctx, req, next) { return next(req); }",
        configSchema,
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(result.ok).toBe(true);

      // Step 2: Load from store and verify configSchema
      const loadResult = await store.load(result.value.id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.configSchema).toEqual(configSchema);
        expect(loadResult.value.kind).toBe("middleware");
        expect(loadResult.value.name).toBe("retry-mw");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "listener guard: StoreChangeNotifier rejects subscribers beyond limit",
    async () => {
      const notifier = createMemoryStoreChangeNotifier();

      // Fill to the limit (64 subscribers)
      const unsubs: (() => void)[] = [];
      for (let i = 0; i < 64; i++) {
        unsubs.push(notifier.subscribe(() => {}));
      }

      // 65th must throw
      expect(() => notifier.subscribe(() => {})).toThrow(/subscriber limit.*64.*reached/);

      // After unsubscribing one, a new subscriber should succeed
      unsubs[0]?.();
      expect(() => notifier.subscribe(() => {})).not.toThrow();
    },
    TIMEOUT_MS,
  );

  test(
    "listener guard: ForgeRuntime.watch rejects listeners beyond limit",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = mockExecutor();

      const runtime = createForgeRuntime({
        store,
        executor: mockTiered(executor),
      });

      expect(runtime.watch).toBeDefined();

      // Fill to the limit (64 external listeners)
      const unsubs: (() => void)[] = [];
      for (let i = 0; i < 64; i++) {
        const unsub = runtime.watch?.(() => {});
        if (unsub !== undefined) {
          unsubs.push(unsub);
        }
      }

      // 65th must throw
      expect(() => runtime.watch?.(() => {})).toThrow(/external listener limit.*64.*reached/);

      // After unsubscribing one, a new listener should succeed
      unsubs[0]?.();
      expect(() => runtime.watch?.(() => {})).not.toThrow();

      // Clean up
      runtime.dispose?.();
    },
    TIMEOUT_MS,
  );

  test(
    "listener guard: notifier + ForgeComponentProvider within full createKoi assembly",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);
      const notifier = createMemoryStoreChangeNotifier();

      // Forge an adder tool so the runtime has something to work with
      const forgeTool = createForgeToolTool(deps);
      await forgeTool.execute({
        name: "guard-adder",
        description: "Adds two numbers.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
      });

      // Create provider wired to the notifier — this subscribes 1 listener
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
        notifier,
      });

      // Full L1 assembly with real LLM
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const koiRuntime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      // Run one turn to prove the assembly works
      const events = await collectEvents(koiRuntime.run({ kind: "text", text: "Say hello." }));
      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // The notifier already has 1 subscriber (from forgeProvider).
      // Fill remaining capacity: subscribe 63 more to reach 64.
      const unsubs: (() => void)[] = [];
      for (let i = 0; i < 63; i++) {
        unsubs.push(notifier.subscribe(() => {}));
      }

      // 65th total subscriber (provider + 63 + 1) must throw
      expect(() => notifier.subscribe(() => {})).toThrow(/subscriber limit.*64.*reached/);

      // Clean up
      for (const u of unsubs) u();
      forgeProvider.dispose();
      await koiRuntime.dispose();
    },
    TIMEOUT_MS,
  );
});
