/**
 * Pi Agent end-to-end validation with real LLM calls.
 *
 * Tests the full createKoi + createPiAdapter stack with real Anthropic API,
 * validating that middleware composition and the Pi engine adapter work
 * together as a real agent.
 *
 * Key architectural notes:
 * - Pi uses streaming-only mode (modelStream terminal).
 * - Middleware hooks like wrapModelCall never fire for Pi — only wrapModelStream
 *   intercepts Pi's model calls.
 * - Pi does NOT re-broadcast text_delta as EngineEvents. Text flows through the
 *   stream bridge internally (visible to wrapModelStream as ModelChunks) but
 *   Pi's subscriber doesn't emit message_update events for bridged text.
 *   To verify LLM text output, use wrapModelStream to observe ModelChunks.
 * - Lifecycle hooks (onSessionStart, onBeforeTurn, etc.) fire normally through L1.
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/pi-agent.test.ts
 *
 * Cost: ~$0.02-0.05 per run (haiku model, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  Tool,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createAuditMiddleware, createInMemoryAuditSink } from "@koi/middleware-audit";
import { createTurnAckMiddleware } from "@koi/middleware-turn-ack";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describePi = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
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

// ---------------------------------------------------------------------------
// 1. Pi agent produces a completed response through createKoi
// ---------------------------------------------------------------------------

describePi("e2e: Pi agent through createKoi", () => {
  test(
    "Pi agent produces a completed response with text output",
    async () => {
      // Pi doesn't re-broadcast text_delta as EngineEvents — observe ModelChunks
      // through wrapModelStream to verify the LLM actually generated text.
      const textChunks: string[] = []; // let justified: test accumulator

      const textObserver: KoiMiddleware = {
        name: "e2e-pi-text-observer",
        wrapModelStream: async function* (_ctx, request, next: ModelStreamHandler) {
          for await (const chunk of next(request)) {
            if (chunk.kind === "text_delta") {
              textChunks.push(chunk.delta);
            }
            yield chunk;
          }
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "You are a concise test agent. Reply in 10 words or fewer.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-agent", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [textObserver],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

        // Got a done event with completed status
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // wrapModelStream observed text_delta ModelChunks (real LLM output)
        expect(textChunks.length).toBeGreaterThan(0);
        const fullText = textChunks.join("");
        expect(fullText.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Pi agent lifecycle hooks fire correctly
// ---------------------------------------------------------------------------

describePi("e2e: Pi agent lifecycle hooks", () => {
  test(
    "onSessionStart/End and onBeforeTurn/AfterTurn fire in correct order",
    async () => {
      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-pi-lifecycle",
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
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-lifecycle", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [lifecycle],
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Hi" }));

        // Lifecycle hooks fired in correct order
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");

        // At least one turn happened
        expect(hookLog).toContain("turn:before");
        expect(hookLog).toContain("turn:after");

        // Turn hooks are bracketed correctly (before comes before after)
        const firstBefore = hookLog.indexOf("turn:before");
        const firstAfter = hookLog.indexOf("turn:after");
        expect(firstBefore).toBeLessThan(firstAfter);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Pi agent wrapModelStream interception (Pi uses streaming, not modelCall)
// ---------------------------------------------------------------------------

describePi("e2e: Pi agent streaming middleware", () => {
  test(
    "wrapModelStream intercepts Pi's real streaming LLM call",
    async () => {
      let streamIntercepted = false; // let justified: toggled in middleware

      const streamObserver: KoiMiddleware = {
        name: "e2e-pi-stream-observer",
        wrapModelStream: (_ctx, request, next: ModelStreamHandler): AsyncIterable<ModelChunk> => {
          streamIntercepted = true;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-stream", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [streamObserver],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Hi" }));

        // wrapModelStream was invoked (Pi routes all calls through modelStream)
        expect(streamIntercepted).toBe(true);

        // Agent still completed successfully
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. Pi agent with audit + turn-ack (session lifecycle middleware)
// ---------------------------------------------------------------------------

describePi("e2e: Pi agent with middleware stack", () => {
  test(
    "audit + turn-ack compose with Pi: session lifecycle logged",
    async () => {
      const auditSink = createInMemoryAuditSink();

      const audit = createAuditMiddleware({ sink: auditSink });
      const turnAck = createTurnAckMiddleware({ debounceMs: 10 });

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply in 5 words or fewer.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-stack", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [audit, turnAck],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "What is 2 + 2?" }));

        // Pi agent completed successfully through the middleware stack
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Audit captured session lifecycle (L1 hooks fire regardless of adapter)
        const kinds = auditSink.entries.map((e) => e.kind);
        expect(kinds).toContain("session_start");
        expect(kinds).toContain("session_end");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "multiple lifecycle middleware compose correctly with Pi",
    async () => {
      const order: string[] = []; // let justified: test accumulator

      const first: KoiMiddleware = {
        name: "e2e-pi-first",
        priority: 100,
        onSessionStart: async () => {
          order.push("first:start");
        },
        onSessionEnd: async () => {
          order.push("first:end");
        },
      };

      const second: KoiMiddleware = {
        name: "e2e-pi-second",
        priority: 200,
        onSessionStart: async () => {
          order.push("second:start");
        },
        onSessionEnd: async () => {
          order.push("second:end");
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-compose", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [second, first], // Out of order — engine sorts by priority
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "OK" }));

        // Session hooks: priority order (100 before 200)
        expect(order.at(0)).toBe("first:start");
        expect(order.at(1)).toBe("second:start");

        // Session end: priority order
        expect(order.at(-2)).toBe("first:end");
        expect(order.at(-1)).toBe("second:end");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 5. Tool-calling: wrapToolCall middleware interception with real LLM
//
// Uses the loop adapter with a two-phase model handler:
//   Phase 1: returns a tool call (deterministic, no LLM flakiness)
//   Phase 2: real Anthropic LLM generates the final answer using tool output
// This validates the full wrapToolCall middleware chain end-to-end.
// ---------------------------------------------------------------------------

describePi("e2e: wrapToolCall with real LLM", () => {
  test(
    "wrapToolCall intercepts tool call, then real LLM uses tool result",
    async () => {
      const interceptedToolIds: string[] = []; // let justified: test accumulator
      let toolExecuted = false; // let justified: toggled in tool execute
      let modelCallCount = 0; // let justified: tracks model call phases

      // Tool registered on the agent entity
      const weatherTool: Tool = {
        descriptor: {
          name: "get_weather",
          description: "Get weather for a city.",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
        trustTier: "sandbox",
        execute: async () => {
          toolExecuted = true;
          return { temperature: "22C", condition: "sunny" };
        },
      };

      const toolProvider: ComponentProvider = {
        name: "e2e-tool-provider",
        attach: async () => {
          const components = new Map<string, unknown>();
          components.set(toolToken("get_weather"), weatherTool);
          return components;
        },
      };

      // wrapToolCall middleware observer
      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          interceptedToolIds.push(request.toolId);
          return next(request);
        },
      };

      // Two-phase model handler:
      // Call 1: deterministic tool call (no LLM involvement)
      // Call 2: real Anthropic LLM generates final response with tool result context
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          // Phase 1: force a tool call deterministically
          return {
            content: "Let me check the weather.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                { toolName: "get_weather", callId: "call-e2e-1", input: { city: "Tokyo" } },
              ],
            },
          };
        }
        // Phase 2: real LLM call — model sees the tool result in context
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-tool-call", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [toolObserver],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Tokyo?" }),
        );

        // Agent completed successfully
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool was executed through the full chain
        expect(toolExecuted).toBe(true);

        // wrapToolCall middleware intercepted the call
        expect(interceptedToolIds).toContain("get_weather");

        // Tool call events were emitted
        const toolStartEvents = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStartEvents.length).toBeGreaterThan(0);
        const toolEndEvents = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEndEvents.length).toBeGreaterThan(0);

        // Real LLM was called for the final response (phase 2)
        expect(modelCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 6. Middleware error propagation through lifecycle hooks
//
// Tests that errors thrown in lifecycle hooks propagate correctly — they are
// NOT swallowed. L1 re-throws non-KoiEngineError errors, ensuring middleware
// bugs surface rather than being silently ignored.
// ---------------------------------------------------------------------------

describePi("e2e: Pi agent error propagation", () => {
  test(
    "lifecycle hook error propagates to caller (not swallowed)",
    async () => {
      let turnCount = 0; // let justified: tracks turns to throw on second

      const errorMiddleware: KoiMiddleware = {
        name: "e2e-pi-error-mw",
        onBeforeTurn: async () => {
          turnCount++;
          // Throw on the second turn (first turn starts the session normally)
          if (turnCount >= 2) {
            throw new Error("Intentional lifecycle hook error for testing");
          }
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-error", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [errorMiddleware],
      });

      try {
        // The error should propagate — L1 re-throws non-KoiEngineError errors
        let caughtError: unknown; // let justified: assigned in catch block
        try {
          await collectEvents(runtime.run({ kind: "text", text: "Hi" }));
        } catch (e: unknown) {
          caughtError = e;
        }

        // Error was propagated, not silently swallowed
        expect(caughtError).toBeDefined();
        expect(caughtError).toBeInstanceOf(Error);
        if (caughtError instanceof Error) {
          expect(caughtError.message).toBe("Intentional lifecycle hook error for testing");
        }

        // First turn started successfully (error occurs on second turn)
        expect(turnCount).toBeGreaterThanOrEqual(2);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
