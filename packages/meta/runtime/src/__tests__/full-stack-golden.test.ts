/**
 * Full-stack golden query set — ALL L2 packages active, complete ATIF trajectory.
 *
 * This is the "full" golden query that verifies every L2 package produces
 * observable output in the ATIF trajectory. New L2 packages MUST add
 * themselves to this test.
 *
 * Packages exercised:
 * - @koi/model-openai-compat: model terminals (model_call steps)
 * - @koi/query-engine: stream consumer (ModelChunk → EngineEvent)
 * - @koi/event-trace: model/tool I/O recording (middleware)
 * - @koi/hooks: hook dispatch on model/tool events (middleware)
 * - @koi/mcp: transport state machine lifecycle recording
 * - @koi/channel-cli: channel adapter (verified via runtime boot)
 * - @koi/permissions: permission backend (bypass mode, allow-all rules)
 * - @koi/middleware-permissions: permission gating middleware (MW spans)
 * - @koi/tools-core: buildTool() — ToolDefinition → Tool factory
 * - @koi/tools-builtin: builtin search tools (Glob provider)
 *
 * Gated on E2E_TESTS=1 + OPENROUTER_API_KEY for live API.
 * VCR replay version (full-stack.cassette.json) runs in CI.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
// @koi/channel-cli: channel adapter
import { createCliChannel } from "@koi/channel-cli";
import type { EngineAdapter, EngineEvent, EngineInput, JsonObject, ModelChunk } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
// @koi/event-trace: trajectory recording middleware
import { createEventTraceMiddleware } from "@koi/event-trace";
// @koi/hooks: hook dispatch
import { createHookMiddleware, loadHooks } from "@koi/hooks";
// @koi/mcp: transport state machine
import { createTransportStateMachine } from "@koi/mcp";
// @koi/middleware-permissions: permission gating middleware
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
// @koi/model-openai-compat: model adapter
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
// @koi/permissions: permission backend
import { createPermissionBackend } from "@koi/permissions";
// @koi/query-engine: stream consumer
import { consumeModelStream } from "@koi/query-engine";
// @koi/tools-builtin: builtin search tools
import { createBuiltinSearchProvider } from "@koi/tools-builtin";
// @koi/tools-core: tool building
import { buildTool } from "@koi/tools-core";

import { createHookObserver } from "../middleware/hook-dispatch.js";
import { recordMcpLifecycle } from "../middleware/mcp-lifecycle.js";
import { wrapMiddlewareWithTrace } from "../middleware/trace-wrapper.js";
import { createAtifDocumentStore } from "../trajectory/atif-store.js";
import { createFsAtifDelegate } from "../trajectory/fs-delegate.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const E2E = process.env.E2E_TESTS === "1";
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "google/gemini-2.0-flash-001";

const describeE2E = E2E && API_KEY ? describe : describe.skip;

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

// ---------------------------------------------------------------------------
// Tool: add_numbers (built via @koi/tools-core buildTool)
// ---------------------------------------------------------------------------

const addToolResult = buildTool({
  name: "add_numbers",
  description: "Add two numbers together",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" },
    },
    required: ["a", "b"],
  },
  origin: "primordial",
  execute: async (args: JsonObject): Promise<unknown> => ({
    result: (args.a as number) + (args.b as number),
  }),
});

if (!addToolResult.ok) {
  throw new Error(`buildTool failed: ${addToolResult.error.message}`);
}
const addTool = addToolResult.value;

// ---------------------------------------------------------------------------
// Full-stack golden query (E2E with real LLM)
// ---------------------------------------------------------------------------

describeE2E("Full-stack golden: ALL L2 packages in ATIF trajectory", () => {
  test("complete trajectory with hooks, MCP, event-trace, model, tool, channel, permissions", async () => {
    const trajDir = `/tmp/koi-full-stack-${Date.now()}`;
    trajDirs.push(trajDir);
    const docId = "full-stack";

    const store = createAtifDocumentStore(
      { agentName: "full-stack-test" },
      createFsAtifDelegate(trajDir),
    );

    // --- @koi/event-trace: trajectory recording middleware ---
    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "full-stack-test",
    });

    // --- @koi/hooks: define test hooks ---
    const hookResult = loadHooks([
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "hook-fired"],
        filter: { events: ["tool.succeeded"] },
      },
    ]);
    expect(hookResult.ok).toBe(true);
    const hookConfigs = hookResult.ok ? hookResult.value : [];

    const { onExecuted, middleware: hookObserverMw } = createHookObserver({ store, docId });
    const hookMiddleware = createHookMiddleware({ hooks: hookConfigs, onExecuted });

    // --- @koi/permissions + @koi/middleware-permissions: permission gating ---
    const permBackend = createPermissionBackend({
      mode: "bypass",
      rules: [{ pattern: "*", action: "*", effect: "allow", source: "policy" }],
    });
    const permHandle = createPermissionsMiddleware({
      backend: permBackend,
      description: "test permissions (bypass mode)",
    });

    // --- @koi/mcp: transport state machine lifecycle ---
    const mcpStateMachine = createTransportStateMachine();
    const unsubMcp = recordMcpLifecycle({
      stateMachine: mcpStateMachine,
      store,
      docId,
      serverName: "test-mcp-server",
    });

    // Simulate MCP lifecycle: idle → connecting → connected
    mcpStateMachine.transition({ kind: "connecting", attempt: 1 });
    mcpStateMachine.transition({ kind: "connected" });

    // --- @koi/channel-cli: verify channel boots ---
    const channel = createCliChannel();
    expect(channel.name).toBeDefined();
    expect(channel.capabilities.text).toBe(true);

    // --- @koi/model-openai-compat: real model adapter ---
    const modelAdapter = createOpenAICompatAdapter({
      apiKey: API_KEY ?? "",
      baseUrl: "https://openrouter.ai/api/v1",
      model: MODEL,
      retry: { maxRetries: 1 },
    });

    // --- Bridge adapter with agent loop ---
    const bridgeAdapter: EngineAdapter = {
      engineId: "full-stack",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: modelAdapter.complete,
        modelStream: modelAdapter.stream,
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const handlers = input.callHandlers;
        if (handlers === undefined) {
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
        const messages: {
          readonly senderId: string;
          readonly timestamp: number;
          readonly content: readonly { readonly kind: "text"; readonly text: string }[];
          readonly metadata?: JsonObject;
        }[] = [{ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] }];
        return (async function* () {
          const MAX_TURNS = 2;
          // let: mutable
          let turnIndex = 0;
          while (turnIndex < MAX_TURNS) {
            const turnEvents: EngineEvent[] = [];
            // let: mutable
            let doneEvent: EngineEvent | undefined;
            for await (const event of consumeModelStream(
              handlers.modelStream
                ? handlers.modelStream({ messages, model: MODEL })
                : (async function* (): AsyncIterable<ModelChunk> {
                    const r = await handlers.modelCall({ messages, model: MODEL });
                    yield { kind: "done" as const, response: { content: r.content, model: MODEL } };
                  })(),
              input.signal,
            )) {
              if (event.kind === "done") {
                doneEvent = event;
              } else {
                turnEvents.push(event);
                yield event;
              }
            }
            const toolCalls = turnEvents.filter((e) => e.kind === "tool_call_end");
            if (toolCalls.length === 0) {
              if (doneEvent) yield doneEvent;
              break;
            }
            for (const tc of toolCalls) {
              if (tc.kind !== "tool_call_end") continue;
              const result = tc.result as {
                readonly toolName: string;
                readonly parsedArgs?: JsonObject;
              };
              if (!result.parsedArgs) continue;
              const realCallId = tc.callId as string;
              // Assistant message (tool-use intent)
              messages.push({
                senderId: "assistant",
                timestamp: Date.now(),
                content: [{ kind: "text", text: "" }],
                metadata: { callId: realCallId, toolName: result.toolName } as JsonObject,
              });
              const toolResponse = await handlers.toolCall({
                toolId: result.toolName,
                input: result.parsedArgs,
              });
              const out =
                typeof toolResponse.output === "string"
                  ? toolResponse.output
                  : JSON.stringify(toolResponse.output);
              // Tool result with real callId linkage
              messages.push({
                senderId: "tool",
                timestamp: Date.now(),
                content: [{ kind: "text", text: out }],
                metadata: { callId: realCallId, toolName: result.toolName } as JsonObject,
              });
            }
            turnIndex++;
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

    // --- createKoi: full engine loop ---
    const runtime = await createKoi({
      manifest: { name: "full-stack-agent", version: "0.1.0", model: { name: MODEL } },
      adapter: bridgeAdapter,
      middleware: [eventTrace, hookMiddleware, hookObserverMw, permHandle].map((mw) =>
        wrapMiddlewareWithTrace(mw, { store, docId }),
      ),
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
        // @koi/tools-builtin: builtin search tools (Glob, Grep, ToolSearch)
        createBuiltinSearchProvider({ cwd: process.cwd() }),
      ],
      loopDetection: false,
    });

    // Run the agent
    const events: EngineEvent[] = [];
    for await (const event of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5. After getting the result, respond with just the number.",
    })) {
      events.push(event);
    }

    // Cleanup + flush
    unsubMcp();
    mcpStateMachine.transition({ kind: "closed" });
    await runtime.dispose();
    // Wait for all async trajectory writes (event-trace onSessionEnd, hook dispatch, MCP)
    await new Promise((r) => setTimeout(r, 500));

    // -----------------------------------------------------------------------
    // Verify COMPLETE ATIF trajectory
    // -----------------------------------------------------------------------
    const steps = await store.getDocument(docId);

    console.log(`\n=== Full-Stack ATIF Trajectory (${steps.length} steps) ===`);
    for (const s of steps) {
      const label = s.identifier.startsWith("hook:")
        ? "hook"
        : s.identifier.startsWith("mcp:")
          ? "mcp"
          : s.kind;
      console.log(`  [${label}] ${s.identifier} (${s.durationMs.toFixed(0)}ms) ${s.outcome}`);
      if (s.request?.text) console.log(`        in:  ${s.request.text.slice(0, 100)}`);
      if (s.response?.text) console.log(`        out: ${s.response.text.slice(0, 100)}`);
    }

    // --- MCP lifecycle steps (source: system, type: mcp_lifecycle) ---
    const mcpSteps = steps.filter((s) => s.metadata?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
    expect(mcpSteps.some((s) => s.metadata?.transportState === "connecting")).toBe(true);
    expect(mcpSteps.some((s) => s.metadata?.transportState === "connected")).toBe(true);

    // --- Model call steps (from event-trace) ---
    const modelSteps = steps.filter(
      (s) => s.kind === "model_call" && !s.identifier.startsWith("middleware:"),
    );
    expect(modelSteps.length).toBeGreaterThan(0);
    expect(modelSteps[0]?.identifier).toBe(MODEL);

    // --- Tool call steps (from event-trace) ---
    const toolSteps = steps.filter((s) => s.kind === "tool_call" && s.identifier === "add_numbers");
    expect(toolSteps.length).toBeGreaterThan(0);
    expect(toolSteps[0]?.outcome).toBe("success");

    // --- Hook execution steps (source: system, type: hook_execution) ---
    const hookSteps = steps.filter((s) => s.metadata?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThan(0);
    expect(hookSteps[0]?.metadata?.hookName).toBe("on-tool-exec");

    // --- Middleware span steps (source: system, type: middleware_span) ---
    const mwSpans = steps.filter((s) => s.metadata?.type === "middleware_span");
    expect(mwSpans.length).toBeGreaterThan(0);
    // Should have spans for hooks and permissions middleware
    // (event-trace is excluded from trace wrapper — see TRACE_EXCLUDED)
    const mwNames = new Set(mwSpans.map((s) => s.metadata?.middlewareName));
    expect(mwNames.has("hooks")).toBe(true);
    // @koi/middleware-permissions: permission checks show up as MW spans
    expect(mwNames.has("permissions")).toBe(true);
    // Each span should have hook, phase, priority, nextCalled
    for (const span of mwSpans) {
      expect(span.metadata?.hook).toBeDefined();
      expect(span.metadata?.phase).toBeDefined();
      expect(span.metadata?.priority).toBeDefined();
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    }

    // --- Verify ATIF file on disk ---
    const files = await readdir(trajDir);
    expect(files.filter((f) => f.endsWith(".atif.json")).length).toBeGreaterThan(0);

    // --- Verify agent-level metadata (Harbor v1.6 compliance) ---
    const rawDoc = await (await import("node:fs/promises")).readFile(
      `${trajDir}/${files.find((f) => f.endsWith(".atif.json"))}`,
      "utf-8",
    );
    const atifDoc = JSON.parse(rawDoc) as {
      readonly agent?: {
        readonly model_name?: string;
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    // Harbor v1.6 compliance: agent-level metadata
    expect(atifDoc.agent?.model_name).toBe(MODEL);
    expect(atifDoc.agent?.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
    // @koi/tools-builtin: builtin tools appear in agent metadata
    expect(atifDoc.agent?.tool_definitions?.some((t) => t.name === "Glob")).toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Non-E2E: verify all L2 packages are exercised (structural check)
// ---------------------------------------------------------------------------

describe("Full-stack: L2 package wiring verification", () => {
  test("all L2 packages importable and functional", async () => {
    // @koi/event-trace
    const { createEventTraceMiddleware: et } = await import("@koi/event-trace");
    expect(typeof et).toBe("function");

    // @koi/hooks
    const { loadHooks: lh, createHookRegistry: chr } = await import("@koi/hooks");
    expect(typeof lh).toBe("function");
    expect(typeof chr).toBe("function");

    // @koi/mcp
    const { createTransportStateMachine: ctsm, loadMcpJsonString: lmjs } = await import("@koi/mcp");
    expect(typeof ctsm).toBe("function");
    expect(typeof lmjs).toBe("function");

    // @koi/model-openai-compat
    const { createOpenAICompatAdapter: coaa } = await import("@koi/model-openai-compat");
    expect(typeof coaa).toBe("function");

    // @koi/query-engine
    const { consumeModelStream: cms } = await import("@koi/query-engine");
    expect(typeof cms).toBe("function");

    // @koi/channel-cli
    const { createCliChannel: ccc } = await import("@koi/channel-cli");
    expect(typeof ccc).toBe("function");
  });
});
