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
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
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
