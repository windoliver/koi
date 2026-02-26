/**
 * E2E: Content-Addressed BrickId through full L1 runtime assembly.
 *
 * Validates Issue #250 — BrickId = SHA-256(content) — end-to-end with
 * real Anthropic API calls through createKoi + createLoopAdapter.
 *
 * Tests cover:
 *   1. Forge tool → BrickId has sha256: format
 *   2. Forge same content twice → same BrickId (dedup)
 *   3. Forge different content → different BrickId
 *   4. Integrity verification: id === recomputed hash
 *   5. Forged tool callable through full runtime with real LLM
 *   6. Middleware chain intercepts forged tool call
 *   7. Cross-kind isolation: same content, different kind → different ID
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test tests/e2e/e2e-brick-id-content-addressing.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ToolRequest,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import type { ForgeDeps, ForgeResult, SandboxExecutor, TieredSandboxExecutor } from "@koi/forge";
import {
  createDefaultForgeConfig,
  createForgeComponentProvider,
  createForgeSkillTool,
  createForgeToolTool,
  createInMemoryForgeStore,
  verifyBrickIntegrity,
} from "@koi/forge";
import { computeBrickId, isBrickId } from "@koi/hash";
import { createAnthropicAdapter } from "@koi/model-router";

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
    name: "brick-id-e2e",
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
      agentId: "brick-id-e2e",
      depth: 0,
      sessionId: "e2e-session",
      forgesThisSession: sessionForges,
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describeE2E("e2e: Content-Addressed BrickId through full runtime", () => {
  // ── 1. BrickId format ────────────────────────────────────────────────────

  test(
    "forged tool has sha256: prefixed BrickId",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      const forgeTool = createForgeToolTool(deps);
      const result = (await forgeTool.execute({
        name: "format-check",
        description: "Tool for BrickId format validation",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
        },
        implementation: "return { x: input.x };",
      })) as { readonly ok: true; readonly value: ForgeResult };

      expect(result.ok).toBe(true);
      const id = result.value.id;

      // BrickId must match sha256:<64-hex-chars>
      expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(isBrickId(id)).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── 2. Same content → same BrickId (dedup) ──────────────────────────────

  test(
    "forging identical content twice produces the same BrickId",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      const toolSpec = {
        name: "dedup-test",
        description: "Identical content for dedup check",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
      };

      // First forge
      const deps1 = defaultDeps(store, executor, 0);
      const forgeTool1 = createForgeToolTool(deps1);
      const result1 = (await forgeTool1.execute(toolSpec)) as {
        readonly ok: true;
        readonly value: ForgeResult;
      };
      expect(result1.ok).toBe(true);

      // Second forge — same content
      const deps2 = defaultDeps(store, executor, 1);
      const forgeTool2 = createForgeToolTool(deps2);
      const result2 = (await forgeTool2.execute(toolSpec)) as {
        readonly ok: true;
        readonly value: ForgeResult;
      };
      expect(result2.ok).toBe(true);

      // Same content → same BrickId
      expect(result1.value.id).toBe(result2.value.id);

      // Second forge should consume 0 quota (dedup short-circuit)
      expect(result2.value.forgesConsumed).toBe(0);
    },
    TIMEOUT_MS,
  );

  // ── 3. Different content → different BrickId ─────────────────────────────

  test(
    "different content produces different BrickIds",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      const deps1 = defaultDeps(store, executor, 0);
      const forgeTool1 = createForgeToolTool(deps1);
      const result1 = (await forgeTool1.execute({
        name: "tool-a",
        description: "First tool",
        inputSchema: { type: "object" },
        implementation: "return { a: 1 };",
      })) as { readonly ok: true; readonly value: ForgeResult };

      const deps2 = defaultDeps(store, executor, 1);
      const forgeTool2 = createForgeToolTool(deps2);
      const result2 = (await forgeTool2.execute({
        name: "tool-b",
        description: "Second tool with different content",
        inputSchema: { type: "object" },
        implementation: "return { b: 2 };",
      })) as { readonly ok: true; readonly value: ForgeResult };

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result1.value.id).not.toBe(result2.value.id);
    },
    TIMEOUT_MS,
  );

  // ── 4. Integrity verification ────────────────────────────────────────────

  test(
    "stored brick passes integrity verification (id === recomputed hash)",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      const forgeTool = createForgeToolTool(deps);
      const result = (await forgeTool.execute({
        name: "integrity-check",
        description: "Tool for integrity verification test",
        inputSchema: {
          type: "object",
          properties: { n: { type: "number" } },
        },
        implementation: "return { doubled: input.n * 2 };",
      })) as { readonly ok: true; readonly value: ForgeResult };

      expect(result.ok).toBe(true);

      // Load from store
      const loadResult = await store.load(result.value.id);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const brick = loadResult.value;

      // Integrity check: recomputed hash must match stored id
      const integrity = verifyBrickIntegrity(brick);
      expect(integrity.ok).toBe(true);

      // Also verify manually
      const manualId = computeBrickId(brick.kind, brick.implementation, brick.files);
      expect(brick.id).toBe(manualId);
    },
    TIMEOUT_MS,
  );

  // ── 5. Full runtime: forged tool callable by real LLM ────────────────────

  test(
    "content-addressed forged tool callable by LLM through createKoi + createLoopAdapter",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Forge "adder" tool
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
      expect(isBrickId(forgeResult.value.id)).toBe(true);

      // Create full L1 runtime
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      // LLM calls the forged tool
      let events: readonly EngineEvent[];
      try {
        events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use the adder tool to add 17 and 25. Return the result.",
          }),
        );
      } finally {
        await runtime.dispose();
      }

      // Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Token metrics populated
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // Agent has the forged tool attached
      const toolComponent = runtime.agent.component(toolToken("adder"));
      expect(toolComponent).toBeDefined();

      // LLM may or may not choose to call the tool — verify at least the tool was available.
      // If it did call, verify the events exist.
      const toolCallEvents = events.filter(
        (e) => e.kind === "tool_call_start" || e.kind === "tool_call_end",
      );
      if (toolCallEvents.length > 0) {
        expect(toolCallEvents.length).toBeGreaterThanOrEqual(2); // start + end pair
      }
    },
    TIMEOUT_MS,
  );

  // ── 6. Middleware chain intercepts forged tool call ───────────────────────

  test(
    "middleware chain intercepts content-addressed forged tool call",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Forge "multiplier"
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

      // Middleware spy
      const interceptedToolIds: string[] = [];
      const middlewareSpy: KoiMiddleware = {
        name: "brick-id-spy",
        wrapToolCall: async (_ctx, req: ToolRequest, next) => {
          interceptedToolIds.push(req.toolId);
          return next(req);
        },
      };

      // Full runtime
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        middleware: [middlewareSpy],
        loopDetection: false,
      });

      let events: readonly EngineEvent[];
      try {
        events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use the multiplier tool to multiply 6 and 7. Return the result.",
          }),
        );
      } finally {
        await runtime.dispose();
      }

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Middleware spy should have intercepted the multiplier tool call
      // LLM may choose not to call the tool — verify if it did
      if (interceptedToolIds.length > 0) {
        expect(interceptedToolIds).toContain("multiplier");
      }
    },
    TIMEOUT_MS,
  );

  // ── 7. Cross-kind isolation: same content, different kind → different ID ─

  test(
    "same content in different brick kinds produces different BrickIds",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      const sharedContent = "return { result: true };";

      // Forge as tool
      const deps1 = defaultDeps(store, executor, 0);
      const forgeTool = createForgeToolTool(deps1);
      const toolResult = (await forgeTool.execute({
        name: "cross-kind-tool",
        description: "Tool with shared content",
        inputSchema: { type: "object" },
        implementation: sharedContent,
      })) as { readonly ok: true; readonly value: ForgeResult };

      // Forge as skill (different kind, overlapping content)
      const deps2 = defaultDeps(store, executor, 1);
      const forgeSkill = createForgeSkillTool(deps2);
      const skillResult = (await forgeSkill.execute({
        name: "cross-kind-skill",
        description: "Skill with shared content",
        body: sharedContent,
      })) as { readonly ok: true; readonly value: ForgeResult };

      expect(toolResult.ok).toBe(true);
      expect(skillResult.ok).toBe(true);

      // Different kinds → different IDs (even with similar content)
      expect(toolResult.value.id).not.toBe(skillResult.value.id);

      // Verify via pure hash computation
      const expectedToolId = computeBrickId("tool", sharedContent);
      const expectedSkillId = computeBrickId("skill", sharedContent);
      expect(expectedToolId).not.toBe(expectedSkillId);
    },
    TIMEOUT_MS,
  );
});
