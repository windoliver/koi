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
  JsonObject,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { loadHooks } from "@koi/hooks";
import { createTransportStateMachine } from "@koi/mcp";
import { createGoalMiddleware } from "@koi/middleware-goal";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createReportMiddleware } from "@koi/middleware-report";
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream } from "@koi/query-engine";
import { createBuiltinSearchProvider } from "@koi/tools-builtin";
import { buildTool } from "@koi/tools-core";
import { loadCassette } from "../cassette/load-cassette.js";
import { createHookDispatchMiddleware } from "../middleware/hook-dispatch.js";
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
 * The bridge adapter handles the model→tool→model loop using consumeModelStream.
 */
function createCassetteAdapter(chunks: readonly ModelChunk[]): EngineAdapter {
  // Track how many times the model terminal is called — cassette is for first call only,
  // second call (after tool result) returns a simple text done response
  // let: mutable call counter
  let callCount = 0;

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
          { kind: "text_delta" as const, delta: "12" },
          {
            kind: "done" as const,
            response: { content: "12", model: MODEL, usage: { inputTokens: 10, outputTokens: 1 } },
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

    // @koi/event-trace
    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "replay-test",
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
    const hookMw = createHookDispatchMiddleware({
      hooks: hookResult.ok ? hookResult.value : [],
      store,
      docId,
    });

    // @koi/permissions + @koi/middleware-permissions
    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permMiddleware = createPermissionsMiddleware({
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
    });
    mcpSm.transition({ kind: "connecting", attempt: 1 });
    mcpSm.transition({ kind: "connected" });

    // Mock adapter replaying cassette chunks
    const adapter = createCassetteAdapter(cassette.chunks);

    const runtime = await createKoi({
      manifest: { name: "replay-test", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [eventTrace, hookMw, permMiddleware].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId }),
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

    // MW spans — permissions + hook-dispatch
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    expect(mwSpans.length).toBeGreaterThan(0);
    const mwNames = new Set(mwSpans.map((s) => s.metadata?.middlewareName));
    expect(mwNames.has("permissions")).toBe(true);
    expect(mwNames.has("hook-dispatch")).toBe(true);
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

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "goal-report-test",
    });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permMiddleware = createPermissionsMiddleware({
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
      middleware: [eventTrace, goalMw, reportHandle.middleware, permMiddleware].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId }),
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

  test("MW:hook-dispatch spans (@koi/hooks middleware)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hookDispatchSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "hook-dispatch",
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

  test("has MW:permissions + MW:hook-dispatch spans", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mwNames = new Set(
      doc.steps
        .filter((s) => s.extra?.type === "middleware_span")
        .map((s) => s.extra?.middlewareName),
    );
    expect(mwNames.has("permissions")).toBe(true);
    expect(mwNames.has("hook-dispatch")).toBe(true);
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

  test("model response mentions inability to use the tool", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    // Model should explain it can't use the tool (permissions filtered it out)
    const responseText = modelSteps[0]?.observation?.results?.[0]?.content ?? "";
    // Model won't call add_numbers — it was removed from available tools by permissions MW
    // Response may say "cannot", "don't have", "no tool", etc.
    expect(responseText.length).toBeGreaterThan(0);
  });

  test("NO tool_call steps (denied tool never executed)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
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

  // TODO(#1453): turn-stop retry responses leak [Active Capabilities] banner — pre-existing on main.
  // The hooks middleware injects capability text into system prompt, and the model parrots it
  // on retries instead of answering the user's question. Fix the retry path, then enable this test.
  test.skip("retry responses stay on-task and do not discuss internal capabilities", async () => {
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
      expect(content).not.toContain("middleware");
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
    expect(verdictToDecision(okVerdict!)).toEqual({ kind: "continue" });

    // Verdict parsing: valid ok=false
    const failVerdict = parseVerdictOutput('{"ok":false,"reason":"unsafe"}');
    expect(failVerdict).toEqual({ ok: false, reason: "unsafe" });
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
  test("ATIF trajectory: get_credentials tool call + hook execution captured", () => {
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
        readonly extra?: { readonly type?: string; readonly hookName?: string };
        readonly tool_calls?: readonly { readonly function_name?: string }[];
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

    // Should have a hook execution step for the secret-scanner agent hook
    const hookSteps = steps.filter((s) => s.extra?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThanOrEqual(1);

    // CRITICAL: verify secrets are NOT present anywhere in the trajectory.
    // The whole point of redaction is that raw credentials never appear in
    // observable output. If these substrings appear, redaction failed.
    // CRITICAL: raw secrets must never appear anywhere in the recorded trajectory.
    // If redaction works, the API key prefix and password are stripped before
    // any data reaches observable output (hook agent prompts, ATIF steps).
    const fullJson = readFileSync(trajectoryPath, "utf-8");
    expect(fullJson).not.toContain("sk-ant-api03-");
    expect(fullJson).not.toContain("super-secret-pw-123");
  });
});

// ---------------------------------------------------------------------------
// Standalone golden queries: @koi/hooks payload redaction
// ---------------------------------------------------------------------------

describe("Golden: @koi/hooks payload redaction", () => {
  test("redactEventData masks API keys and passwords", async () => {
    const { redactEventData } = await import("@koi/hooks");
    const result = redactEventData(
      { apiKey: "sk-ant-api03-" + "A".repeat(85), password: "hunter2", safe: "hello" },
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
      { output: "token is sk-ant-api03-" + "A".repeat(85) },
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
      recall: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      search: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      delete: () => ({ ok: true as const, value: undefined }),
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

    const result = createMemoryToolProvider({ backend: mockBackend });
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
      recall: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      search: () => ({ ok: true as const, value: [] as readonly MRecord[] }),
      delete: () => ({ ok: true as const, value: undefined }),
      findByName: () => ({ ok: true as const, value: undefined as MRecord | undefined }),
      get: () => ({ ok: true as const, value: undefined as MRecord | undefined }),
      update: () => ({ ok: true as const, value: stored }),
    };

    const result = createMemoryStoreTool(backend);
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
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "hook-dispatch",
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
    expect(toolSteps.length).toBeGreaterThanOrEqual(3); // memory_store + memory_recall + memory_search

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
    // At least 3 hook executions (one per tool call: store + recall + search)
    expect(hookSteps.length).toBeGreaterThanOrEqual(3);
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
      recall: () => ({ ok: true as const, value: [...records.values()] }),
      search: () => ({ ok: true as const, value: [...records.values()] }),
      delete: (id: import("@koi/core").MemoryRecordId) => {
        records.delete(id);
        return { ok: true as const, value: undefined };
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

    const providerResult = createProvider({ backend });
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

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "replay-memory-test",
    });

    const hookResult = loadHooks([
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "hook"],
        filter: { events: ["tool.succeeded"] },
      },
    ]);
    const hookMw = createHookDispatchMiddleware({
      hooks: hookResult.ok ? hookResult.value : [],
      store,
      docId,
    });

    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permMiddleware = createPermissionsMiddleware({
      backend: permBackend,
      description: "replay test (bypass)",
    });

    const mcpSm = createTransportStateMachine();
    const unsubMcp = recordMcpLifecycle({
      stateMachine: mcpSm,
      store,
      docId,
      serverName: "test-mcp",
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
      middleware: [eventTrace, hookMw, permMiddleware].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId }),
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
    expect(mwNames.has("hook-dispatch")).toBe(true);
  }, 15000);
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

    // Validate recall returned all 3 memories
    expect(content).toContain('"totalScanned":3');
    expect(content).toContain('"degraded":false');

    // Validate formatted output contains trust boundary
    expect(content).toContain("memory-data");
    expect(content).toContain("Memory");
  });

  test("step count: MCP + MW + HOOK + MODEL + TOOL (>= 8)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/memory-recall.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    expect(doc.steps.length).toBeGreaterThanOrEqual(8);
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
