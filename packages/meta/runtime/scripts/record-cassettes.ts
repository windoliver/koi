#!/usr/bin/env bun
/**
 * Records VCR cassettes + full-stack ATIF trajectories.
 *
 * Run: OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts
 *
 * ALL L2 packages wired:
 *   @koi/model-openai-compat  — model adapter (stream + complete)
 *   @koi/query-engine         — stream consumer (ModelChunk → EngineEvent)
 *   @koi/event-trace          — trajectory recording middleware
 *   @koi/hooks                — hook dispatch middleware
 *   @koi/mcp                  — transport state machine lifecycle
 *   @koi/permissions          — permission backend (bypass mode)
 *   @koi/middleware-permissions — permission gating middleware (MW spans)
 *   @koi/tools-core           — buildTool() for add_numbers
 *   @koi/tools-builtin        — Glob/Grep/ToolSearch providers
 *
 * Produces:
 *   fixtures/simple-text.cassette.json      — VCR replay: text response
 *   fixtures/simple-text.trajectory.json    — Full ATIF: simple text (no tools)
 *   fixtures/tool-use.cassette.json         — VCR replay: tool call
 *   fixtures/tool-use.trajectory.json       — Full ATIF: tool use (model → tool → model)
 */

import type { EngineAdapter, EngineEvent, EngineInput, JsonObject, ModelChunk } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { loadHooks } from "@koi/hooks";
import { createTransportStateMachine } from "@koi/mcp";
// @koi/middleware-permissions: permission gating middleware
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
// @koi/permissions: permission backend
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream } from "@koi/query-engine";
// @koi/tools-builtin: builtin search tools
import { createBuiltinSearchProvider } from "@koi/tools-builtin";
// @koi/tools-core: tool building
import { buildTool } from "@koi/tools-core";
import type { Cassette } from "../src/cassette/types.js";
import { createHookDispatchMiddleware } from "../src/middleware/hook-dispatch.js";
import { recordMcpLifecycle } from "../src/middleware/mcp-lifecycle.js";
import { wrapMiddlewareWithTrace } from "../src/middleware/trace-wrapper.js";
import { createAtifDocumentStore } from "../src/trajectory/atif-store.js";
import { createFsAtifDelegate } from "../src/trajectory/fs-delegate.js";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const MODEL = "google/gemini-2.0-flash-001";
const FIXTURES = `${import.meta.dirname}/../fixtures`;

const modelAdapter = createOpenAICompatAdapter({
  apiKey: API_KEY,
  baseUrl: "https://openrouter.ai/api/v1",
  model: MODEL,
  retry: { maxRetries: 1 },
});

// ---------------------------------------------------------------------------
// Tool: add_numbers (built via @koi/tools-core buildTool)
// ---------------------------------------------------------------------------

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

if (!addToolResult.ok) {
  console.error(`buildTool failed: ${addToolResult.error.message}`);
  process.exit(1);
}
const addTool = addToolResult.value;

// =========================================================================
// Helpers
// =========================================================================

async function recordCassette(
  name: string,
  factory: () => AsyncIterable<ModelChunk>,
): Promise<void> {
  console.log(`Recording ${name}.cassette.json...`);
  const chunks: ModelChunk[] = [];
  for await (const c of factory()) chunks.push(c);
  await Bun.write(
    `${FIXTURES}/${name}.cassette.json`,
    JSON.stringify(
      { name, model: MODEL, recordedAt: Date.now(), chunks } satisfies Cassette,
      null,
      2,
    ),
  );
  console.log(`  ${chunks.length} chunks`);
}

/**
 * Records a full-stack ATIF trajectory with ALL L2 packages active.
 * @param name - fixture name (e.g., "simple-text" or "tool-use")
 * @param prompt - the user prompt
 * @param withTools - whether to register add_numbers tool + builtin tools
 */
async function recordFullStackTrajectory(
  name: string,
  prompt: string,
  withTools: boolean,
): Promise<void> {
  console.log(`\nRecording ${name}.trajectory.json (full-stack, all L2)...`);

  const trajDir = `/tmp/koi-record-${name}-${Date.now()}`;
  const docId = name;
  const store = createAtifDocumentStore(
    { agentName: `golden-${name}` },
    createFsAtifDelegate(trajDir),
  );

  // @koi/event-trace
  const { middleware: eventTrace } = createEventTraceMiddleware({
    store,
    docId,
    agentName: `golden-${name}`,
  });

  // @koi/hooks
  const hookResult = loadHooks([
    {
      kind: "command",
      name: "on-model-done",
      cmd: ["echo", "model-done"],
      filter: { events: ["model.completed"] },
    },
    ...(withTools
      ? [
          {
            kind: "command" as const,
            name: "on-tool-exec",
            cmd: ["echo", "tool-done"],
            filter: { events: ["tool.executed"] },
          },
        ]
      : []),
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
    description: "golden query permissions (bypass mode)",
  });

  // @koi/mcp
  const mcpSm = createTransportStateMachine();
  const unsubMcp = recordMcpLifecycle({
    stateMachine: mcpSm,
    store,
    docId,
    serverName: "test-mcp-server",
  });
  mcpSm.transition({ kind: "connecting", attempt: 1 });
  mcpSm.transition({ kind: "connected" });

  // Bridge adapter
  const bridge: EngineAdapter = {
    engineId: `golden-${name}`,
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: { modelCall: modelAdapter.complete, modelStream: modelAdapter.stream },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const h = input.callHandlers;
      if (!h)
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
      const text = input.kind === "text" ? input.text : "";
      const msgs: {
        readonly senderId: string;
        readonly timestamp: number;
        readonly content: readonly { readonly kind: "text"; readonly text: string }[];
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
            yield { kind: "turn_end" as const, turnIndex: turn };
            if (done) yield done;
            break;
          }
          for (const tc of tcs) {
            if (tc.kind !== "tool_call_end") continue;
            const r = tc.result as { readonly toolName: string; readonly parsedArgs?: JsonObject };
            if (!r.parsedArgs) continue;
            const resp = await h.toolCall({ toolId: r.toolName, input: r.parsedArgs });
            const out = typeof resp.output === "string" ? resp.output : JSON.stringify(resp.output);
            msgs.push({
              senderId: "tool",
              timestamp: Date.now(),
              content: [{ kind: "text", text: `Tool ${r.toolName}: ${out}` }],
            });
          }
          msgs.push({
            senderId: "system",
            timestamp: Date.now(),
            content: [{ kind: "text", text: "Respond with the result. No tools." }],
          });
          yield { kind: "turn_end" as const, turnIndex: turn };
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

  // Wrap middleware with trace (auto-captures all MW I/O)
  // event-trace excluded from trace wrapper (TRACE_EXCLUDED), hook-dispatch + permissions traced
  const tracedMiddleware = [eventTrace, hookMw, permMiddleware].map((mw) =>
    wrapMiddlewareWithTrace(mw, { store, docId }),
  );

  const providers = withTools
    ? [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
        // @koi/tools-builtin: builtin search tools (Glob, Grep, ToolSearch)
        createBuiltinSearchProvider({ cwd: process.cwd() }),
      ]
    : [];

  const runtime = await createKoi({
    manifest: { name: `golden-${name}`, version: "0.1.0", model: { name: MODEL } },
    adapter: bridge,
    middleware: tracedMiddleware,
    providers,
    loopDetection: false,
  });

  for await (const _e of runtime.run({ kind: "text", text: prompt })) {
    /* drain */
  }

  // Manually flush event-trace (engine's onSessionEnd may not complete before we read)
  const fakeSession = {
    agentId: name,
    sessionId: docId as never,
    runId: `${docId}:r0` as never,
    metadata: {},
  };
  const fakeTurn = {
    session: fakeSession,
    turnIndex: 0,
    turnId: `${docId}:r0:t0` as never,
    messages: [] as readonly never[],
    metadata: {},
  };
  if (eventTrace.onAfterTurn) await eventTrace.onAfterTurn(fakeTurn);
  if (eventTrace.onSessionEnd) await eventTrace.onSessionEnd(fakeSession);

  unsubMcp();
  mcpSm.transition({ kind: "closed" });
  await runtime.dispose();
  await new Promise((r) => setTimeout(r, 300));

  // Save full ATIF document
  const { readdir, readFile } = await import("node:fs/promises");
  const files = await readdir(trajDir);
  const atifFile = files.find((f) => f.endsWith(".atif.json"));
  if (!atifFile) {
    console.error(`  ERROR: No ATIF file for ${name}`);
    return;
  }
  const rawAtif = JSON.parse(await readFile(`${trajDir}/${atifFile}`, "utf-8"));
  await Bun.write(`${FIXTURES}/${name}.trajectory.json`, JSON.stringify(rawAtif, null, 2));

  const steps = rawAtif.steps ?? [];
  console.log(
    `  ${steps.length} steps | model: ${rawAtif.agent?.model_name} | tools: ${JSON.stringify(rawAtif.agent?.tool_definitions?.map((t: { name: string }) => t.name) ?? [])}`,
  );
  for (const s of steps) {
    const etype = s.extra?.type ?? "";
    const label =
      etype === "mcp_lifecycle"
        ? "MCP"
        : etype === "hook_execution"
          ? "HOOK"
          : etype === "middleware_span"
            ? `MW:${s.extra?.middlewareName}`
            : s.source === "agent"
              ? "MODEL"
              : s.source === "tool"
                ? "TOOL"
                : s.source;
    console.log(
      `  [${s.step_id.toString().padStart(2)}] ${label.padEnd(20)} ${s.outcome ?? "?"} ${(s.duration_ms ?? 0).toFixed(0).padStart(5)}ms`,
    );
  }

  const { rmSync } = await import("node:fs");
  rmSync(trajDir, { recursive: true, force: true });
}

// =========================================================================
// Record everything
// =========================================================================

// Cassettes (VCR replay for CI)
await recordCassette("simple-text", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "What is 2+2? Answer with just the number." }],
      },
    ],
  }),
);
await recordCassette("tool-use", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "Use the add_numbers tool to compute 7 + 5" }],
      },
    ],
    tools: [addTool.descriptor],
  }),
);

// Full-stack ATIF trajectories (both golden queries)
// simple-text: covers model call, MCP lifecycle, MW spans (hook-dispatch + permissions), hooks
// tool-use: covers model call, tool call, MCP lifecycle, MW spans, hooks, permissions wrapToolCall
await recordFullStackTrajectory("simple-text", "What is 2+2? Answer with just the number.", false);
await recordFullStackTrajectory(
  "tool-use",
  "Use the add_numbers tool to compute 7 + 5. After getting the result, respond with just the number.",
  true,
);

console.log("\nDone. 4 fixture files ready:");
console.log("  fixtures/simple-text.cassette.json");
console.log("  fixtures/simple-text.trajectory.json");
console.log("  fixtures/tool-use.cassette.json");
console.log("  fixtures/tool-use.trajectory.json");
