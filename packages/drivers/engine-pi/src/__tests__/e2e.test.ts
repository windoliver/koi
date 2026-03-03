/**
 * End-to-end tests for @koi/engine-pi with real Anthropic API calls.
 *
 * Validates the full pi adapter stack with a live LLM:
 *   - Text streaming (text_delta events, done event, metrics)
 *   - Tool call execution (tool_call_start → tool_call_end → result in response)
 *   - Middleware intercept (wrapModelCall fires during real LLM call)
 *   - Multi-turn: agent uses tool, gets result, continues
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during parallel `bun test --recursive`
 * to avoid rate-limit failures when 500+ test files run simultaneously.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core/ecs";
import type { ComposedCallHandlers, EngineEvent, EngineOutput } from "@koi/core/engine";
import type { ModelChunk, ModelRequest, ToolRequest } from "@koi/core/middleware";
import { createPiAdapter } from "../adapter.js";
import { createModelCallTerminal, createModelStreamTerminal } from "../model-terminal.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
// E2E tests require API key AND explicit opt-in via E2E_TESTS=1 to avoid
// rate-limit failures when 500+ test files run in parallel.
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// Model to use for all E2E tests — haiku for speed + cost
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

function extractToolStarts(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_start" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function extractToolEnds(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_end" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
  );
}

/**
 * Build real callHandlers wired to the pi model terminals.
 * No middleware wrapping — direct terminal calls for E2E correctness tests.
 */
function buildDirectHandlers(
  tools: readonly ToolDescriptor[] = [],
  toolExecutor: (request: ToolRequest) => Promise<{ readonly output: unknown }> = async () => ({
    output: "ok",
  }),
): ComposedCallHandlers {
  const modelStreamTerminal = createModelStreamTerminal();
  const modelCallTerminal = createModelCallTerminal(modelStreamTerminal);
  return {
    modelCall: modelCallTerminal,
    modelStream: modelStreamTerminal,
    toolCall: toolExecutor,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Tool descriptors used in tests
// ---------------------------------------------------------------------------

const ADD_NUMBERS_TOOL: ToolDescriptor = {
  name: "add_numbers",
  description: "Adds two integers together and returns the sum.",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "integer", description: "First number" },
      b: { type: "integer", description: "Second number" },
    },
    required: ["a", "b"],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: engine-pi with real Anthropic API", () => {
  // ── Test 1: Simple text streaming ──────────────────────────────────────

  test(
    "streams text_delta events and emits done with metrics",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async (_provider) => ANTHROPIC_KEY,
      });

      const events = await collectEvents(
        adapter.stream({
          kind: "text",
          text: "Reply with exactly one word: pong",
          callHandlers: buildDirectHandlers(),
        }),
      );

      // Must have at least one text_delta and a done event
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

      // Response should contain "pong"
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");
    },
    TIMEOUT_MS,
  );

  // ── Test 2: turn_end events ─────────────────────────────────────────────

  test(
    "emits turn_end events with incrementing turnIndex",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async (_provider) => ANTHROPIC_KEY,
      });

      const events = await collectEvents(
        adapter.stream({
          kind: "text",
          text: "Say: OK",
          callHandlers: buildDirectHandlers(),
        }),
      );

      const turnEnds = events.filter(
        (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
      );
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);
      expect(turnEnds[0]?.turnIndex).toBe(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call execution ─────────────────────────────────────────

  test(
    "executes tool call: emits tool_call_start and tool_call_end with correct callId",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the add_numbers tool to answer math questions. Do not compute in your head.",
        getApiKey: async (_provider) => ANTHROPIC_KEY,
      });

      // let justified: capture what toolId was called so we can assert it
      let capturedToolId: string | undefined;
      let capturedInput: Record<string, unknown> | undefined;

      const toolExecutor = async (request: ToolRequest) => {
        capturedToolId = request.toolId;
        capturedInput = request.input as Record<string, unknown>;
        const a = Number(request.input.a ?? 0);
        const b = Number(request.input.b ?? 0);
        return { output: String(a + b) };
      };

      const events = await collectEvents(
        adapter.stream({
          kind: "text",
          text: "Use the add_numbers tool to compute 7 + 5. Then tell me the result.",
          callHandlers: buildDirectHandlers([ADD_NUMBERS_TOOL], toolExecutor),
        }),
      );

      // Tool should have been called
      expect(capturedToolId).toBe("add_numbers");
      expect(capturedInput?.a).toBeDefined();
      expect(capturedInput?.b).toBeDefined();

      // tool_call_start and tool_call_end events must be emitted
      const starts = extractToolStarts(events);
      const ends = extractToolEnds(events);
      expect(starts.length).toBeGreaterThanOrEqual(1);
      expect(ends.length).toBeGreaterThanOrEqual(1);

      // callId must match between start and end
      const startCallId = starts[0]?.callId;
      const endCallId = ends[0]?.callId;
      expect(startCallId).toBeDefined();
      expect(startCallId).toBe(endCallId);

      // tool_call_start should have correct tool name
      expect(starts[0]?.toolName).toBe("add_numbers");

      // Final response should mention the result (12)
      const text = extractText(events);
      expect(text).toContain("12");

      // Done event with completed status
      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Multi-turn (tool use → continue) ────────────────────────────

  test(
    "accumulates metrics across multiple turns (tool use + final answer)",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the add_numbers tool for any arithmetic.",
        getApiKey: async (_provider) => ANTHROPIC_KEY,
      });

      // let justified: count tool calls
      let toolCallCount = 0;
      const toolExecutor = async (request: ToolRequest) => {
        toolCallCount++;
        const a = Number(request.input.a ?? 0);
        const b = Number(request.input.b ?? 0);
        return { output: String(a + b) };
      };

      const events = await collectEvents(
        adapter.stream({
          kind: "text",
          text: "Use add_numbers tool: first compute 3+4, then compute 10+20. Report both results.",
          callHandlers: buildDirectHandlers([ADD_NUMBERS_TOOL], toolExecutor),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.stopReason).toBe("completed");

      // At least 1 tool call happened
      expect(toolCallCount).toBeGreaterThanOrEqual(1);

      // Metrics should accumulate across turns
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);
      expect(output.metrics.turns).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Middleware wrapModelCall intercepts real LLM call ───────────

  test(
    "wrapModelCall middleware intercepts the real LLM call",
    async () => {
      // let justified: track intercepted requests
      let interceptedCount = 0;
      let interceptedModel: string | undefined;

      // Build handlers with middleware wrapping the modelStream terminal
      const modelStreamTerminal = createModelStreamTerminal();
      const modelCallTerminal = createModelCallTerminal(modelStreamTerminal);

      // Wrap modelStream: count invocations and capture model id
      const wrappedModelStream = async function* (
        request: ModelRequest,
      ): AsyncIterable<ModelChunk> {
        interceptedCount++;
        interceptedModel = request.model;
        yield* modelStreamTerminal(request);
      };

      const handlers: ComposedCallHandlers = {
        modelCall: modelCallTerminal,
        modelStream: wrappedModelStream,
        toolCall: async () => ({ output: "ok" }),
        tools: [],
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async (_provider) => ANTHROPIC_KEY,
      });

      const events = await collectEvents(
        adapter.stream({
          kind: "text",
          text: "Say: middleware-ok",
          callHandlers: handlers,
        }),
      );

      // Middleware must have fired at least once
      expect(interceptedCount).toBeGreaterThanOrEqual(1);
      expect(interceptedModel).toBeDefined();

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("middleware");
    },
    TIMEOUT_MS,
  );

  // ── Test 6: messages input kind ─────────────────────────────────────────

  test(
    "messages input kind works with real model",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async (_provider) => ANTHROPIC_KEY,
      });

      const events = await collectEvents(
        adapter.stream({
          kind: "messages",
          messages: [
            {
              content: [{ kind: "text" as const, text: "Say the word 'banana' and nothing else." }],
              senderId: "e2e-user",
              timestamp: Date.now(),
            },
          ],
          callHandlers: buildDirectHandlers(),
        }),
      );

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("banana");
    },
    TIMEOUT_MS,
  );
});
