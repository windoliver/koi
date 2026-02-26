/**
 * Full-stack E2E: createKoi + createPiAdapter + real Anthropic LLM + tools.
 *
 * Validates system integrity after tool-call-timeout changes:
 *   - Real LLM call streams text_delta events
 *   - LLM calls a registered tool, gets result, uses it in response
 *   - wrapToolCall middleware fires correctly in the chain
 *   - Agent lifecycle: created → running → terminated
 *
 * NOTE: This tests the engine-level tool execution path (callHandlers.toolCall
 * → middleware → tool.execute), NOT the Node-level handleToolCall timeout.
 * The Node-level timeout is tested in packages/node/src/__tests__/e2e-timeout.test.ts.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-full-stack.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(): AgentManifest {
  return {
    name: "E2E Full-Stack Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

const GET_WEATHER_TOOL: Tool = {
  descriptor: {
    name: "get_weather",
    description: "Returns the current weather for a city. Always returns sunny 22C for testing.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const city = String(input.city ?? "unknown");
    return JSON.stringify({ city, temperature: 22, condition: "sunny" });
  },
};

/** ComponentProvider that registers tools on the agent entity. */
function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Simple text response through full L1 runtime ────────────

  test(
    "streams text response through createKoi + createPiAdapter",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      expect(runtime.agent.state).toBe("terminated");

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.stopReason).toBe("completed");
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Tool call through the middleware chain ──────────────────

  test(
    "LLM calls a registered tool through the middleware chain",
    async () => {
      // let justified: capture tool call metadata for assertions
      let toolCallObserved = false;
      let observedToolId: string | undefined;

      const observerMiddleware: KoiMiddleware = {
        name: "tool-call-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallObserved = true;
          observedToolId = request.toolId;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observerMiddleware],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 8. Then tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware must have intercepted the tool call
      expect(toolCallObserved).toBe(true);
      expect(observedToolId).toBe("multiply");

      // tool_call_start and tool_call_end events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should mention 56
      const text = extractText(events);
      expect(text).toContain("56");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Multiple middleware hooks fire in correct order ──────────

  test(
    "session and turn lifecycle hooks fire through the full stack",
    async () => {
      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycleObserver],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      // Session lifecycle must be correct
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Multi-tool agent with middleware interposition ──────────

  test(
    "agent uses multiple tools with middleware observing each call",
    async () => {
      const toolCalls: string[] = [];

      const toolLogger: KoiMiddleware = {
        name: "tool-logger",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have access to multiply and get_weather tools. Use them when asked. Always use tools instead of computing yourself.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolLogger],
        providers: [createToolProvider([MULTIPLY_TOOL, GET_WEATHER_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "First, use get_weather for Tokyo. Then use multiply to compute 9 * 11. Report both results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // At least one tool should have been called
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Response should contain weather and/or multiplication results
      const text = extractText(events);
      const hasWeather = text.includes("22") || text.includes("sunny") || text.includes("Tokyo");
      const hasMath = text.includes("99");
      expect(hasWeather || hasMath).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Guard limits work with real adapter ─────────────────────

  test(
    "iteration guard limits turns with real adapter",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool for every question. Never answer without using a tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createToolProvider([MULTIPLY_TOOL])],
        limits: { maxTurns: 3 },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Compute 2*3, then 4*5, then 6*7, then 8*9, then 10*11. Report all.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      // Might be "completed" or "max_turns" depending on how many turns the model needs
      expect(output?.metrics.turns).toBeLessThanOrEqual(3);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
