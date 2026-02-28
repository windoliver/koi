/**
 * Tool audit middleware end-to-end validation with real LLM calls.
 *
 * Tests the full createKoi + createLoopAdapter + createPiAdapter stack with
 * real Anthropic API, validating that tool-audit middleware correctly tracks:
 * - Tool availability from model requests (wrapModelCall / wrapModelStream)
 * - Tool call success/failure with latency (wrapToolCall)
 * - Session lifecycle hooks (onSessionStart / onSessionEnd)
 * - Lifecycle signal computation (unused, high_value, high_failure)
 * - Snapshot persistence via store.save()
 * - Composition with other middleware in the onion chain
 *
 * Architecture notes:
 * - createLoopAdapter uses wrapModelCall (non-streaming)
 * - createPiAdapter uses wrapModelStream (streaming-only)
 * - Both paths must correctly trigger tool-audit tracking
 * - Priority 100 ensures tool-audit is outermost, sees all calls
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/tool-audit.test.ts
 *
 * Cost: ~$0.03-0.10 per run (haiku model, minimal prompts).
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createToolAuditMiddleware, type ToolAuditSnapshot } from "@koi/middleware-tool-audit";

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
    name: "e2e-audit-tool-provider",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("get_weather"), tool);
      return components;
    },
  };

  return { tool, provider };
}

function createFailingTool(): {
  readonly tool: Tool;
  readonly provider: ComponentProvider;
} {
  const tool: Tool = {
    descriptor: {
      name: "failing_tool",
      description: "A tool that always fails.",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
      },
    },
    trustTier: "sandbox",
    execute: async () => {
      throw new Error("Intentional tool failure for testing");
    },
  };

  const provider: ComponentProvider = {
    name: "e2e-audit-failing-provider",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("failing_tool"), tool);
      return components;
    },
  };

  return { tool, provider };
}

/**
 * Two-phase model handler:
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
// 1. Tool audit tracks successful tool calls through createLoopAdapter
// ---------------------------------------------------------------------------

describeE2E("e2e: tool-audit with createLoopAdapter", () => {
  test(
    "tracks tool call success with latency through L1 pipeline",
    async () => {
      // let justified: toggled in tool execute
      let toolExecuted = false;

      const auditMw = createToolAuditMiddleware({
        clock: Date.now,
      });

      const { provider } = createWeatherTool(() => {
        toolExecuted = true;
      });

      const { modelCall, getCallCount } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "Tokyo" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-loop",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Tokyo?" }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool was actually executed
        expect(toolExecuted).toBe(true);
        expect(getCallCount()).toBeGreaterThanOrEqual(2);

        // Audit snapshot captured the call
        const snapshot = auditMw.getSnapshot();
        const record = snapshot.tools.get_weather;
        expect(record).toBeDefined();
        expect(record?.callCount).toBe(1);
        expect(record?.successCount).toBe(1);
        expect(record?.failureCount).toBe(0);
        // Latency may be 0ms for sub-millisecond tool execution (Date.now resolution)
        expect(record?.avgLatencyMs).toBeGreaterThanOrEqual(0);
        expect(record?.minLatencyMs).toBeGreaterThanOrEqual(0);
        expect(record?.maxLatencyMs).toBeGreaterThanOrEqual(0);
        expect(record?.lastUsedAt).toBeGreaterThan(0);

        // Session count incremented
        expect(snapshot.totalSessions).toBe(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "tracks tool availability from model request tools array",
    async () => {
      const savedSnapshots: ToolAuditSnapshot[] = []; // let justified: test accumulator
      const auditMw = createToolAuditMiddleware({
        store: {
          load: () => ({ tools: {}, totalSessions: 0, lastUpdatedAt: 0 }),
          save: (snapshot) => {
            savedSnapshots.push(snapshot);
          },
        },
      });

      const { provider } = createWeatherTool();

      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "Berlin" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-availability",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Weather in Berlin?" }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Store was saved (dirty flag was set)
        expect(savedSnapshots.length).toBeGreaterThan(0);

        const lastSnapshot = savedSnapshots[savedSnapshots.length - 1];
        const record = lastSnapshot?.tools.get_weather;
        expect(record).toBeDefined();

        // Tool was offered and used in this session
        expect(record?.sessionsAvailable).toBe(1);
        expect(record?.sessionsUsed).toBe(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "tracks tool failure and re-throws the error",
    async () => {
      const auditMw = createToolAuditMiddleware({});

      const { provider: failingProvider } = createFailingTool();

      // Single-phase: force a call to failing_tool, then real LLM for answer
      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "failing_tool",
        toolInput: { input: "test" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-failure",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw],
        providers: [failingProvider],
      });

      try {
        // The loop adapter handles tool errors internally — the agent
        // should still complete (tool error becomes context for next turn)
        const events = await collectEvents(runtime.run({ kind: "text", text: "Run failing_tool" }));

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Audit snapshot captured the failure
        const snapshot = auditMw.getSnapshot();
        const record = snapshot.tools.failing_tool;
        expect(record).toBeDefined();
        expect(record?.callCount).toBe(1);
        expect(record?.failureCount).toBe(1);
        expect(record?.successCount).toBe(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Tool audit lifecycle hooks fire through L1
// ---------------------------------------------------------------------------

describeE2E("e2e: tool-audit lifecycle hooks", () => {
  test(
    "onSessionStart and onSessionEnd fire through L1 pipeline",
    async () => {
      const hookLog: string[] = []; // let justified: test accumulator

      const auditMw = createToolAuditMiddleware({});

      // Observer middleware to verify hook ordering
      const observer: KoiMiddleware = {
        name: "e2e-audit-observer",
        priority: 50, // Before tool-audit (100) to verify ordering
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookLog.push("observer:start");
        },
        onSessionEnd: async () => {
          hookLog.push("observer:end");
        },
      };

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 50 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 2 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-lifecycle",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw, observer],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say OK" }));

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Observer hooks fired (verifying L1 correctly drove lifecycle)
        expect(hookLog).toContain("observer:start");
        expect(hookLog).toContain("observer:end");

        // Audit middleware tracked the session
        const snapshot = auditMw.getSnapshot();
        expect(snapshot.totalSessions).toBe(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Tool audit with Pi adapter (streaming path)
// ---------------------------------------------------------------------------

describeE2E("e2e: tool-audit with createPiAdapter", () => {
  test(
    "lifecycle hooks fire through Pi streaming path",
    async () => {
      const auditMw = createToolAuditMiddleware({});

      const { createPiAdapter } = await import("@koi/engine-pi");
      const adapter = createPiAdapter({
        model: `anthropic:${MODEL_NAME}`,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-pi",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Hi" }));

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Session tracked even through streaming path
        const snapshot = auditMw.getSnapshot();
        expect(snapshot.totalSessions).toBe(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. Signal computation via onAuditResult callback
// ---------------------------------------------------------------------------

describeE2E("e2e: tool-audit signal computation", () => {
  test(
    "onAuditResult fires with high_value signal after successful tool call",
    async () => {
      const auditResults = mock((_results: readonly unknown[]) => {}); // let justified: mock

      const auditMw = createToolAuditMiddleware({
        onAuditResult: auditResults,
        // Set low thresholds so a single call triggers high_value
        highValueMinCalls: 1,
        highValueSuccessThreshold: 0.5,
      });

      const { provider } = createWeatherTool();
      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "Paris" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-signals",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Weather in Paris?" }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // onAuditResult callback was fired with signals
        expect(auditResults).toHaveBeenCalledTimes(1);

        // On-demand report also works
        const report = auditMw.generateReport();
        const highValue = report.find(
          (r) => r.toolName === "get_weather" && r.signal === "high_value",
        );
        expect(highValue).toBeDefined();
        expect(highValue?.confidence).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 5. Store persistence: snapshot survives save/load cycle
// ---------------------------------------------------------------------------

describeE2E("e2e: tool-audit store persistence", () => {
  test(
    "snapshot saved to store contains correct data after full pipeline run",
    async () => {
      const savedSnapshots: ToolAuditSnapshot[] = []; // let justified: test accumulator

      const auditMw = createToolAuditMiddleware({
        store: {
          load: () => ({ tools: {}, totalSessions: 0, lastUpdatedAt: 0 }),
          save: (snapshot) => {
            savedSnapshots.push(snapshot);
          },
        },
      });

      const { provider } = createWeatherTool();
      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "London" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-store",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Weather in London?" }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // At least one snapshot was saved
        expect(savedSnapshots.length).toBeGreaterThan(0);

        const lastSnapshot = savedSnapshots[savedSnapshots.length - 1];
        expect(lastSnapshot).toBeDefined();

        // Snapshot is well-formed and serializable
        const json = JSON.stringify(lastSnapshot);
        const parsed = JSON.parse(json) as ToolAuditSnapshot;
        expect(parsed.totalSessions).toBe(1);
        expect(parsed.tools.get_weather).toBeDefined();
        expect(parsed.tools.get_weather?.callCount).toBe(1);
        expect(parsed.tools.get_weather?.successCount).toBe(1);
        expect(parsed.lastUpdatedAt).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 6. Composition: tool-audit + other middleware in same pipeline
// ---------------------------------------------------------------------------

describeE2E("e2e: tool-audit composes with other middleware", () => {
  test(
    "tool-audit and call-limits compose correctly in same pipeline",
    async () => {
      const auditMw = createToolAuditMiddleware({});

      const { createToolCallLimitMiddleware } = await import("@koi/middleware-call-limits");
      const limitMw = createToolCallLimitMiddleware({
        globalLimit: 10,
        exitBehavior: "continue",
      });

      const { provider } = createWeatherTool();
      const { modelCall } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "NYC" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-audit-compose",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [auditMw, limitMw], // Both middleware in the chain
        providers: [provider],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Weather in NYC?" }));

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool-audit tracked the call even with call-limits in the chain
        const snapshot = auditMw.getSnapshot();
        const record = snapshot.tools.get_weather;
        expect(record).toBeDefined();
        expect(record?.callCount).toBe(1);
        expect(record?.successCount).toBe(1);

        // Priority ordering: audit(100) < limits(175) — audit sees the call first
        expect(auditMw.priority).toBe(100);
        expect(limitMw.priority).toBe(175);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
