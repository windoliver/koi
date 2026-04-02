#!/usr/bin/env bun
/**
 * Records VCR cassettes + full-stack ATIF trajectories.
 *
 * Run: OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts
 *
 * Golden queries (4 trajectories):
 *   simple-text      — text response, no tools, permissions bypass
 *   tool-use         — add_numbers tool call, permissions bypass, hooks fire
 *   glob-use         — Glob builtin tool call, permissions bypass
 *   permission-deny  — permissions default mode denies add_numbers, Glob allowed
 *
 * ALL L2 packages wired across queries:
 *   @koi/model-openai-compat  — model adapter
 *   @koi/query-engine         — stream consumer
 *   @koi/event-trace          — trajectory recording
 *   @koi/hooks                — hook dispatch
 *   @koi/mcp                  — transport lifecycle
 *   @koi/permissions          — permission backend
 *   @koi/middleware-permissions — permission gating MW
 *   @koi/tools-core           — buildTool()
 *   @koi/tools-builtin        — Glob/Grep/ToolSearch
 */

import type {
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  ModelChunk,
} from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { loadHooks } from "@koi/hooks";
import { createTransportStateMachine } from "@koi/mcp";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream } from "@koi/query-engine";
import { createBuiltinSearchProvider } from "@koi/tools-builtin";
import { buildTool } from "@koi/tools-core";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
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
// Tools (built via @koi/tools-core)
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
// Recording helpers
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

// ---------------------------------------------------------------------------
// Per-query config
// ---------------------------------------------------------------------------

interface QueryConfig {
  readonly name: string;
  readonly prompt: string;
  readonly permissionMode: "bypass" | "default";
  readonly permissionRules: readonly SourcedRule[];
  readonly permissionDescription: string;
  readonly hooks: readonly {
    readonly kind: "command";
    readonly name: string;
    readonly cmd: readonly string[];
    readonly filter: { readonly events: readonly string[] };
  }[];
  readonly providers: readonly ComponentProvider[];
  /** Max model→tool turns. Default 1. Set to 0 for text-only (no tool loop). */
  readonly maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Full-stack trajectory recorder
// ---------------------------------------------------------------------------

async function recordTrajectory(config: QueryConfig): Promise<void> {
  const { name, prompt } = config;
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
  const hookResult = loadHooks([...config.hooks]);
  const hookMw = createHookDispatchMiddleware({
    hooks: hookResult.ok ? hookResult.value : [],
    store,
    docId,
  });

  // @koi/permissions + @koi/middleware-permissions
  const permBackend = createPermissionBackend({
    mode: config.permissionMode,
    rules: [...config.permissionRules],
  });
  const permMiddleware = createPermissionsMiddleware({
    backend: permBackend,
    description: config.permissionDescription,
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
      const maxTurns = config.maxTurns ?? 1;
      const msgs: {
        readonly senderId: string;
        readonly timestamp: number;
        readonly content: readonly { readonly kind: "text"; readonly text: string }[];
        readonly metadata?: JsonObject;
      }[] = [{ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] }];
      return (async function* () {
        // let: mutable
        let turn = 0;
        while (turn < maxTurns + 1) {
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
            // Use the real callId from the model, not the tool name
            const realCallId = tc.callId as string;
            // Append assistant message (the tool-use intent)
            msgs.push({
              senderId: "assistant",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "" }],
              metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
            });
            try {
              const resp = await h.toolCall({ toolId: r.toolName, input: r.parsedArgs });
              const out =
                typeof resp.output === "string" ? resp.output : JSON.stringify(resp.output);
              // Append tool result with real callId linkage
              msgs.push({
                senderId: "tool",
                timestamp: Date.now(),
                content: [{ kind: "text", text: out }],
                metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
              });
            } catch (toolErr: unknown) {
              const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
              msgs.push({
                senderId: "tool",
                timestamp: Date.now(),
                content: [{ kind: "text", text: `error: ${errMsg}` }],
                metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
              });
            }
          }
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

  const tracedMiddleware = [eventTrace, hookMw, permMiddleware].map((mw) =>
    wrapMiddlewareWithTrace(mw, { store, docId }),
  );

  const runtime = await createKoi({
    manifest: { name: `golden-${name}`, version: "0.1.0", model: { name: MODEL } },
    adapter: bridge,
    middleware: tracedMiddleware,
    providers: [...config.providers],
    loopDetection: false,
  });

  for await (const _e of runtime.run({ kind: "text", text: prompt })) {
    /* drain */
  }

  unsubMcp();
  mcpSm.transition({ kind: "closed" });
  await runtime.dispose();

  // Wait for async trajectory writes (onSessionEnd flush, hook dispatch, MCP).
  // Poll the store until model steps appear or timeout.
  const maxWaitMs = 3000;
  const pollIntervalMs = 100;
  // let: mutable
  let waited = 0;
  while (waited < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    waited += pollIntervalMs;
    const current = await store.getDocument(docId).catch(() => []);
    const hasModelStep = current.some((s) => s.source === "agent");
    // simple-text has no tools so model step is the only agent step
    // For queries with tools, we need model + tool steps
    if (hasModelStep || waited >= maxWaitMs) break;
  }
  console.log(`  Waited ${waited}ms for trajectory flush`);

  // Save ATIF document
  const { readdir, readFile } = await import("node:fs/promises");
  const files = await readdir(trajDir);
  const atifFile = files.find((f) => f.endsWith(".atif.json"));
  if (!atifFile) {
    console.error(`  ERROR: No ATIF file for ${name}`);
    return;
  }
  const rawAtif = JSON.parse(await readFile(`${trajDir}/${atifFile}`, "utf-8"));
  await Bun.write(`${FIXTURES}/${name}.trajectory.json`, JSON.stringify(rawAtif, null, 2));

  // Print summary
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
    const obs = s.observation?.results?.[0]?.content ?? "";
    const obsPreview = obs ? ` → ${obs.slice(0, 60)}` : "";
    console.log(
      `  [${s.step_id.toString().padStart(2)}] ${label.padEnd(20)} ${(s.outcome ?? "?").padEnd(8)} ${(s.duration_ms ?? 0).toFixed(0).padStart(5)}ms${obsPreview}`,
    );
  }

  const { rmSync } = await import("node:fs");
  rmSync(trajDir, { recursive: true, force: true });
}

// =========================================================================
// Query configs
// =========================================================================

// Web executor for @koi/tools-web (real HTTP in recording, captured in trajectory)
const webExecutor = createWebExecutor({ allowHttps: true });
const webProvider = createWebProvider({
  executor: webExecutor,
  policy: { sandbox: false, capabilities: { network: { allow: true } } },
});

const BYPASS_RULES: readonly SourcedRule[] = [
  { pattern: "*", action: "*", effect: "allow", source: "policy" },
];

const queries: readonly QueryConfig[] = [
  // 1. simple-text: text response, no tools
  {
    name: "simple-text",
    prompt: "What is 2+2? Answer with just the number.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-model-done",
        cmd: ["echo", "model-done"],
        filter: { events: ["turn.ended"] },
      },
    ],
    providers: [],
  },

  // 2. tool-use: add_numbers tool call
  {
    name: "tool-use",
    prompt:
      "Use the add_numbers tool to compute 7 + 5. After getting the result, respond with just the number.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "add-numbers",
        toolName: "add_numbers",
        createTool: () => addTool,
      }),
      createBuiltinSearchProvider({ cwd: process.cwd() }),
    ],
  },

  // 3. glob-use: Glob builtin tool call (@koi/tools-builtin exercised)
  {
    name: "glob-use",
    prompt:
      'Use the Glob tool to find files matching "package.json" in the current directory. Report the count of matches.',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [createBuiltinSearchProvider({ cwd: process.cwd() })],
  },

  // 4. permission-deny: permissions in default mode denies add_numbers
  {
    name: "permission-deny",
    prompt:
      "Use the add_numbers tool to compute 3 + 4. After getting the result, respond with just the number.",
    permissionMode: "default",
    permissionRules: [
      // Deny add_numbers — the LLM should see it filtered from available tools
      { pattern: "tool:add_numbers", action: "*", effect: "deny", source: "policy" },
      // Allow everything else
      { pattern: "*", action: "*", effect: "allow", source: "user" },
    ],
    permissionDescription: "default mode — add_numbers denied",
    hooks: [
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "add-numbers",
        toolName: "add_numbers",
        createTool: () => addTool,
      }),
      createBuiltinSearchProvider({ cwd: process.cwd() }),
    ],
  },

  // 5. web-fetch: @koi/tools-web exercised with real HTTP fetch
  {
    name: "web-fetch",
    prompt: 'Use the web_fetch tool to fetch "http://example.com" and tell me the page title.',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-tool-exec",
        cmd: ["echo", "tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [webProvider],
  },
];

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

// Full-stack ATIF trajectories
for (const q of queries) {
  await recordTrajectory(q);
}

console.log(`\nDone. ${2 + queries.length} fixture files ready:`);
console.log("  fixtures/simple-text.cassette.json");
console.log("  fixtures/tool-use.cassette.json");
for (const q of queries) {
  console.log(`  fixtures/${q.name}.trajectory.json`);
}
