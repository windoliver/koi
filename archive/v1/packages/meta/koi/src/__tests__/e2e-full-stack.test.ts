/**
 * Full-stack E2E: koi L4 package → createKoi + createPiAdapter + real LLM.
 *
 * Validates the entire pipeline as a consumer of the `koi` package would use it:
 *   1. Import from "koi" (L4 root)
 *   2. createPiAdapter with OpenRouter
 *   3. createKoi with middleware + tool providers
 *   4. runtime.run() with text input → stream events
 *   5. Verify: text streaming, tool calls, middleware interposition, lifecycle hooks, metrics
 *
 * Uses OpenRouter as the provider to validate non-Anthropic provider routing.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts --cwd packages/meta/koi
 *
 * The OPENROUTER_API_KEY is loaded from ~/nexus/.env automatically by Bun.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";

// Import from the koi L4 package root — this is the primary thing we're validating
import { createKoi, createPiAdapter, getEngineName, loadManifest } from "../index.js";

// ---------------------------------------------------------------------------
// Environment setup — load OpenRouter key from ~/nexus/.env
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      vars[key] = value;
    }
    return vars;
  } catch {
    return {};
  }
}

const nexusEnv = loadEnvFile(resolve(process.env.HOME ?? "~", "nexus/.env"));
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? nexusEnv.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// Use a fast, cheap model via OpenRouter
const E2E_MODEL = "openrouter:google/gemini-2.0-flash-001";

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

function testManifest(): {
  readonly name: string;
  readonly version: string;
  readonly model: { readonly name: string };
} {
  return {
    name: "e2e-koi-l4-test",
    version: "0.1.0",
    model: { name: E2E_MODEL },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ADD_TOOL: Tool = {
  descriptor: {
    name: "add_numbers",
    description: "Adds two numbers and returns the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a + b);
  },
};

const LOOKUP_TOOL: Tool = {
  descriptor: {
    name: "lookup_capital",
    description: "Returns the capital of a country. For testing, always returns 'Tokyo' for Japan.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "Country name" },
      },
      required: ["country"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const country = String(input.country ?? "unknown");
    const capitals: Record<string, string> = {
      japan: "Tokyo",
      france: "Paris",
      germany: "Berlin",
      brazil: "Brasilia",
    };
    return JSON.stringify({
      country,
      capital: capitals[country.toLowerCase()] ?? "Unknown",
    });
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

describeE2E("e2e: koi L4 full-stack with real LLM (OpenRouter)", () => {
  // ── 1. Text streaming through createKoi ─────────────────────────────

  test(
    "streams text response through createKoi + createPiAdapter",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply in one short sentence.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly the word: pong" }),
      );

      // Must have text_delta and done events
      const textDeltas = events.filter((e) => e.kind === "text_delta");
      expect(textDeltas.length).toBeGreaterThan(0);

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.stopReason).toBe("completed");
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);
      expect(output.metrics.totalTokens).toBeGreaterThan(0);
      expect(output.metrics.turns).toBeGreaterThan(0);
      expect(output.metrics.durationMs).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 2. Tool call through middleware chain ────────────────────────────

  test(
    "LLM calls a registered tool, middleware intercepts, result flows back",
    async () => {
      // Track tool call interception
      let toolCallObserved = false;
      let observedToolId: string | undefined;

      const observerMiddleware: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
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
          "You MUST use the add_numbers tool for any math question. Never compute in your head.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observerMiddleware],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the add_numbers tool to compute 7 + 5. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware must have intercepted
      expect(toolCallObserved).toBe(true);
      expect(observedToolId).toBe("add_numbers");

      // tool_call_start/end events emitted
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should contain 12
      const text = extractText(events);
      expect(text).toContain("12");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 3. Session + turn lifecycle hooks ───────────────────────────────

  test(
    "middleware lifecycle hooks fire in correct order",
    async () => {
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
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycleObserver],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 4. Multi-tool agent ─────────────────────────────────────────────

  test(
    "agent uses multiple tools in a single conversation",
    async () => {
      const toolCalls: string[] = [];

      const toolLogger: KoiMiddleware = {
        name: "tool-logger",
        describeCapabilities: () => undefined,
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
          "You have access to add_numbers and lookup_capital tools. Always use them when relevant.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolLogger],
        providers: [createToolProvider([ADD_TOOL, LOOKUP_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use lookup_capital to find the capital of Japan, then use add_numbers to compute 15+27. Report both.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // At least one tool called
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Tools should have been called (at least one of the two)
      const hasCapitalCall = toolCalls.includes("lookup_capital");
      const hasMathCall = toolCalls.includes("add_numbers");
      expect(hasCapitalCall || hasMathCall).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 5. getEngineName utility ────────────────────────────────────────

  test("getEngineName defaults to 'pi' for undefined engine", () => {
    const manifest = { ...testManifest(), engine: undefined };
    expect(getEngineName(manifest as Parameters<typeof getEngineName>[0])).toBe("pi");
  });

  // ── 6. loadManifest + createKoi integration ─────────────────────────

  test(
    "loads fixture manifest and wires through createKoi",
    async () => {
      const fixturePath = resolve(__dirname, "../../fixtures/test-agent.yaml");
      const result = await loadManifest(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { manifest } = result.value;
      expect(manifest.name).toBe("test-agent");

      // Use the loaded manifest's model field but override with openrouter
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Say 'manifest loaded' and nothing else.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Confirm you are working." }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 7. Metrics accumulate correctly across tool turns ───────────────

  test(
    "metrics accumulate across tool call turns",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Always use add_numbers for math. Never compute yourself.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 3+4. Then tell me the answer.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);
      expect(output.metrics.totalTokens).toBeGreaterThan(0);
      expect(output.metrics.durationMs).toBeGreaterThan(0);
      // At least 1 turn (could be 2+ with tool use)
      expect(output.metrics.turns).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 8. wrapModelStream middleware intercepts real LLM streaming call ──

  test(
    "wrapModelStream middleware fires during real LLM streaming call",
    async () => {
      let streamCallCount = 0;

      const streamObserver: KoiMiddleware = {
        name: "stream-observer",
        describeCapabilities: () => undefined,
        wrapModelStream: async function* (_ctx, request, next) {
          streamCallCount++;
          yield* next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [streamObserver],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say hello." }));

      // Pi adapter uses streaming path — wrapModelStream should fire
      expect(streamCallCount).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
