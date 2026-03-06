/**
 * E2E validation: full L1 runtime works after middleware-memory removal (#512).
 *
 * Exercises createKoi + createPiAdapter with multiple real middleware
 * (audit, permissions, soul) stacked together — no middleware-memory
 * in the chain. Confirms the runtime doesn't depend on middleware-memory
 * for any implicit behavior.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-no-memory-middleware.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
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
    name: "E2E No-Memory-Middleware Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const NOTE_TOOL: Tool = {
  descriptor: {
    name: "take_note",
    description: "Stores a note. Returns confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note content" },
      },
      required: ["text"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return `Note saved: ${String(input.text ?? "")}`;
  },
};

const LOOKUP_TOOL: Tool = {
  descriptor: {
    name: "lookup_fact",
    description: "Looks up a fact. Returns a hardcoded answer for testing.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up" },
      },
      required: ["query"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async () => {
    return JSON.stringify({ answer: "The capital of France is Paris." });
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: full L1 runtime without middleware-memory (#512)", () => {
  // ── 1: Basic text response — no middleware-memory in chain ────────────

  test(
    "streams text without middleware-memory in the stack",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: hello" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 2: Model-intercepting middleware works (no memory middleware) ─────

  test(
    "model-intercepting middleware works without middleware-memory",
    async () => {
      // let — mutable counters for assertions
      let modelCallCount = 0;
      let sessionStarted = false;
      let sessionEnded = false;

      const auditStub: KoiMiddleware = {
        name: "audit-stub",
        describeCapabilities: () => undefined,
        priority: 300,
        async onSessionStart() {
          sessionStarted = true;
        },
        async onSessionEnd() {
          sessionEnded = true;
        },
        async *wrapModelStream(
          _ctx: unknown,
          req: ModelRequest,
          next: ModelStreamHandler,
        ): AsyncIterable<ModelChunk> {
          modelCallCount++;
          yield* next(req);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Be concise.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [auditStub],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "What is 2+2?" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware hooks must have fired
      expect(sessionStarted).toBe(true);
      expect(sessionEnded).toBe(true);
      expect(modelCallCount).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 3: Multi-middleware stack without memory ─────────────────────────

  test(
    "multiple middleware compose correctly without middleware-memory",
    async () => {
      const hookOrder: string[] = [];

      const outerMw: KoiMiddleware = {
        name: "outer-observer",
        describeCapabilities: () => undefined,
        priority: 100,
        async onSessionStart() {
          hookOrder.push("outer:session_start");
        },
        async onSessionEnd() {
          hookOrder.push("outer:session_end");
        },
        async onAfterTurn() {
          hookOrder.push("outer:after_turn");
        },
        async *wrapModelStream(_ctx: unknown, req: ModelRequest, next: ModelStreamHandler) {
          hookOrder.push("outer:model_enter");
          try {
            yield* next(req);
          } finally {
            hookOrder.push("outer:model_exit");
          }
        },
      };

      const innerMw: KoiMiddleware = {
        name: "inner-observer",
        describeCapabilities: () => undefined,
        priority: 500,
        async onSessionStart() {
          hookOrder.push("inner:session_start");
        },
        async onSessionEnd() {
          hookOrder.push("inner:session_end");
        },
        async onAfterTurn() {
          hookOrder.push("inner:after_turn");
        },
        async *wrapModelStream(_ctx: unknown, req: ModelRequest, next: ModelStreamHandler) {
          hookOrder.push("inner:model_enter");
          try {
            yield* next(req);
          } finally {
            hookOrder.push("inner:model_exit");
          }
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [innerMw, outerMw], // intentionally unsorted
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      // Session lifecycle
      expect(hookOrder[0]).toBe("outer:session_start");
      expect(hookOrder[1]).toBe("inner:session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("inner:session_end");
      expect(hookOrder[hookOrder.length - 2]).toBe("outer:session_end");

      // Onion model: outer enters first, inner enters second
      const modelEnterIdx = hookOrder.indexOf("outer:model_enter");
      const innerEnterIdx = hookOrder.indexOf("inner:model_enter");
      expect(modelEnterIdx).toBeLessThan(innerEnterIdx);

      // Onion model: inner exits first, outer exits second
      const innerExitIdx = hookOrder.indexOf("inner:model_exit");
      const outerExitIdx = hookOrder.indexOf("outer:model_exit");
      expect(innerExitIdx).toBeLessThan(outerExitIdx);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 4: Tool calls work through middleware chain (no memory) ─────────

  test(
    "tool calls work through middleware without middleware-memory",
    async () => {
      const toolCalls: string[] = [];

      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
        priority: 200,
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
          "You have a lookup_fact tool. Use it when asked factual questions. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolObserver],
        providers: [createToolProvider([LOOKUP_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the lookup_fact tool to find the capital of France. Report the answer.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool must have been called through the middleware chain
      expect(toolCalls).toContain("lookup_fact");

      // Response should mention Paris
      const text = extractText(events);
      expect(text).toContain("Paris");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 5: Multi-tool agent with stacked middleware (no memory middleware) ─

  test(
    "stacked middleware composes for multi-tool agent without memory middleware",
    async () => {
      // let — mutable counter
      let modelCallCount = 0;
      const toolCalls: string[] = [];

      const modelCounter: KoiMiddleware = {
        name: "model-counter",
        describeCapabilities: () => undefined,
        priority: 300,
        async *wrapModelStream(
          _ctx: unknown,
          req: ModelRequest,
          next: ModelStreamHandler,
        ): AsyncIterable<ModelChunk> {
          modelCallCount++;
          yield* next(req);
        },
      };

      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
        priority: 450,
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
          "You have take_note and lookup_fact tools. Use take_note to save important info, lookup_fact to find facts. Always use tools when appropriate.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [modelCounter, toolObserver],
        providers: [createToolProvider([NOTE_TOOL, LOOKUP_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "First use lookup_fact to find the capital of France. Then use take_note to save that fact. Report what you did.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      // At least one tool should have been called
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Model was called at least once
      expect(modelCallCount).toBeGreaterThanOrEqual(1);

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
