/**
 * Call-limits middleware end-to-end validation with real LLM calls.
 *
 * Tests the full createKoi + createLoopAdapter stack with real Anthropic API,
 * validating that model-call-limit and tool-call-limit middleware compose
 * correctly through the L1 runtime assembly.
 *
 * Architecture note:
 * - createLoopAdapter exposes `terminals.modelCall` to L1
 * - L1's createKoi composes middleware chains around these terminals
 * - wrapModelCall intercepts every model call through the onion chain
 * - wrapToolCall intercepts every tool call through the onion chain
 * - RATE_LIMIT errors from middleware are caught by L1 and converted to
 *   done events with appropriate stopReason
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/call-limits.test.ts
 *
 * Cost: ~$0.01-0.03 per run (haiku model, minimal prompts).
 */

import { describe, expect, mock, test } from "bun:test";
import type { ComponentProvider, EngineEvent, ModelRequest, ModelResponse, Tool } from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import type { LimitReachedInfo } from "@koi/middleware-call-limits";
import {
  createModelCallLimitMiddleware,
  createToolCallLimitMiddleware,
} from "@koi/middleware-call-limits";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
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

function createWeatherTool(onExecute?: () => void): {
  readonly tool: Tool;
  readonly provider: ComponentProvider;
} {
  const tool: Tool = {
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
      onExecute?.();
      return { temperature: "22C", condition: "sunny" };
    },
  };

  const provider: ComponentProvider = {
    name: "e2e-tool-provider",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("get_weather"), tool);
      return components;
    },
  };

  return { tool, provider };
}

/**
 * Creates a two-phase model handler:
 * - Phase 1..N: deterministic tool calls (no LLM cost/flakiness)
 * - Final phase: real Anthropic LLM call for the answer
 */
function createTwoPhaseModelCall(opts: {
  readonly toolCallPhases: number;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
}): {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly getCallCount: () => number;
} {
  // let justified: tracks which phase the model handler is in
  let callCount = 0;

  const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
    callCount++;
    if (callCount <= opts.toolCallPhases) {
      return {
        content: `Calling ${opts.toolName} (phase ${callCount}).`,
        model: MODEL_NAME,
        usage: { inputTokens: 10, outputTokens: 15 },
        metadata: {
          toolCalls: [
            {
              toolName: opts.toolName,
              callId: `call-e2e-${callCount}`,
              input: opts.toolInput,
            },
          ],
        },
      };
    }
    // Real LLM call for the final answer
    const { createAnthropicAdapter } = await import("@koi/model-router");
    const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
    return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
  };

  return { modelCall, getCallCount: () => callCount };
}

// ---------------------------------------------------------------------------
// 1. Model call limit = 0 → RATE_LIMIT → L1 converts to done event
// ---------------------------------------------------------------------------

describeE2E("e2e: model call limit through createKoi", () => {
  test(
    "limit=0 blocks first model call, L1 converts RATE_LIMIT to done event",
    async () => {
      const callback = mock(() => {});
      const mw = createModelCallLimitMiddleware({
        limit: 0,
        onLimitReached: callback,
      });

      // Real LLM terminal — should never be called (blocked by middleware)
      // let justified: toggled in model call to verify it was never reached
      let modelCalled = false;
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCalled = true;
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 50 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-model-limit-0", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [mw],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

        // L1 caught the RATE_LIMIT error and converted to a done event
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Model was never actually called (blocked before reaching terminal)
        expect(modelCalled).toBe(false);

        // onLimitReached callback fired through the real L1 pipeline
        expect(callback).toHaveBeenCalledTimes(1);
        const args = callback.mock.calls[0] as unknown as readonly [LimitReachedInfo];
        expect(args[0].kind).toBe("model");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "limit=2 allows a real two-turn tool conversation without interference",
    async () => {
      const callback = mock(() => {});
      const mw = createModelCallLimitMiddleware({
        limit: 2,
        onLimitReached: callback,
      });

      const { provider } = createWeatherTool();
      const { modelCall, getCallCount } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "Tokyo" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-model-limit-2", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [mw],
        providers: [provider],
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

        // 2 model calls used (within limit): phase 1 tool call + phase 2 real LLM
        expect(getCallCount()).toBe(2);

        // Limit was not exceeded → callback should NOT fire
        expect(callback).toHaveBeenCalledTimes(0);

        // Tool call events were emitted through the pipeline
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Tool call limit through createKoi
// ---------------------------------------------------------------------------

describeE2E("e2e: tool call limit through createKoi", () => {
  test(
    "per-tool limit=1 blocks second call, tool sees blocked response",
    async () => {
      const toolCallback = mock(() => {});
      // let justified: tracks actual tool executions
      let toolExecuteCount = 0;

      const toolMw = createToolCallLimitMiddleware({
        limits: { get_weather: 1 },
        exitBehavior: "continue",
        onLimitReached: toolCallback,
      });

      const { provider } = createWeatherTool(() => {
        toolExecuteCount++;
      });

      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 2, // Two tool call phases — second will be blocked
        toolName: "get_weather",
        toolInput: { city: "Tokyo" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-tool-limit-1", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [toolMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Check weather in Tokyo twice." }),
        );

        // Agent completed (continue behavior doesn't kill the session)
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool executed exactly once (second call was blocked by middleware)
        expect(toolExecuteCount).toBe(1);

        // onLimitReached fired for the blocked tool
        expect(toolCallback).toHaveBeenCalledTimes(1);
        const args = toolCallback.mock.calls[0] as unknown as readonly [LimitReachedInfo];
        expect(args[0].kind).toBe("tool");
        expect(args[0].toolId).toBe("get_weather");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "globalLimit=1 blocks all tools after first call",
    async () => {
      // let justified: tracks actual tool executions
      let toolExecuteCount = 0;

      const toolMw = createToolCallLimitMiddleware({
        globalLimit: 1,
        exitBehavior: "continue",
      });

      const { provider } = createWeatherTool(() => {
        toolExecuteCount++;
      });

      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 2,
        toolName: "get_weather",
        toolInput: { city: "London" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-global-limit", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [toolMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Check weather twice." }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Only 1 tool execution (global limit = 1)
        expect(toolExecuteCount).toBe(1);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Both middleware compose through createKoi in a single pipeline
// ---------------------------------------------------------------------------

describeE2E("e2e: model + tool limits compose together", () => {
  test(
    "both middleware fire correctly in the same pipeline",
    async () => {
      const modelCallback = mock(() => {});
      const toolCallback = mock(() => {});

      const modelMw = createModelCallLimitMiddleware({
        limit: 3,
        onLimitReached: modelCallback,
      });

      const toolMw = createToolCallLimitMiddleware({
        limits: { get_weather: 1 },
        exitBehavior: "continue",
        onLimitReached: toolCallback,
      });

      const { provider } = createWeatherTool();
      const { modelCall, getCallCount } = createTwoPhaseModelCall({
        toolCallPhases: 2, // 2 tool call phases (second blocked), then real LLM = 3 model calls
        toolName: "get_weather",
        toolInput: { city: "Paris" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-compose", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [modelMw, toolMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Paris?" }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // All 3 model calls succeeded (within model limit of 3)
        expect(getCallCount()).toBe(3);

        // Model limit was not exceeded → callback should NOT fire
        expect(modelCallback).toHaveBeenCalledTimes(0);

        // Tool limit fired (get_weather limit=1, called twice → second blocked)
        expect(toolCallback).toHaveBeenCalledTimes(1);
        const args = toolCallback.mock.calls[0] as unknown as readonly [LimitReachedInfo];
        expect(args[0].kind).toBe("tool");
        expect(args[0].toolId).toBe("get_weather");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
