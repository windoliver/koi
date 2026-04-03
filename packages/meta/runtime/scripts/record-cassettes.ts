#!/usr/bin/env bun
/**
 * Records VCR cassettes + full-stack ATIF trajectories.
 *
 * Run: OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts
 *
 * Golden queries (5 trajectories + web-fetch):
 *   simple-text      — text response, no tools, permissions bypass
 *   tool-use         — add_numbers tool call, permissions bypass, hooks fire
 *   glob-use         — Glob builtin tool call, permissions bypass
 *   permission-deny       — permissions default mode denies add_numbers
 *   denial-escalation    — repeated execution-time denials trigger auto-deny escalation
 *   hook-blocked         — pre-call hook blocks model call, stopReason: hook_blocked, Glob allowed
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
  PermissionBackend,
} from "@koi/core";
import {
  createSingleToolProvider,
  serializeMemoryFrontmatter,
  validateMemoryFilePath,
  validateMemoryRecordInput,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createLocalTransport, createNexusFileSystem } from "@koi/fs-nexus";
import { createHookMiddleware, createHookRegistry, loadHooks } from "@koi/hooks";
import {
  createMcpComponentProvider,
  createMcpConnection,
  createMcpResolver,
  createTransportStateMachine,
  resolveServerConfig,
} from "@koi/mcp";
import type { DenialEscalationConfig } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream } from "@koi/query-engine";
import { createMemoryTaskBoardStore } from "@koi/tasks";
import { createBuiltinSearchProvider, createFsReadTool } from "@koi/tools-builtin";
import { buildTool } from "@koi/tools-core";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
// Shared prompts (reused for both cassette + trajectory recording)
// ---------------------------------------------------------------------------

const MEMORY_STORE_PROMPT =
  'Use the memory_store tool to store a feedback memory with name "testing approach", description "always write failing tests first", type "feedback", and content "Rule: write failing tests before implementation.\\n**Why:** catches regressions early.\\n**How to apply:** TDD workflow for all new features.". Then use the memory_list tool to show all stored memories.';

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

// ---------------------------------------------------------------------------
// Task tools (backed by @koi/tasks in-memory store)
// ---------------------------------------------------------------------------

const taskStore = createMemoryTaskBoardStore();

const taskCreateResult = buildTool({
  name: "task_create",
  description: "Create a new task on the task board. Returns the created task.",
  inputSchema: {
    type: "object",
    properties: { description: { type: "string", description: "What the task is about" } },
    required: ["description"],
  },
  origin: "primordial",
  execute: async (args: JsonObject): Promise<unknown> => {
    const id = await taskStore.nextId();
    const now = Date.now();
    const item = {
      id,
      subject: String(args.description),
      description: String(args.description),
      dependencies: [],
      retries: 0,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    };
    await taskStore.put(item);
    return { created: { id, description: item.description, status: item.status } };
  },
});
if (!taskCreateResult.ok) {
  console.error(`buildTool(task_create) failed: ${taskCreateResult.error.message}`);
  process.exit(1);
}
const taskCreateTool = taskCreateResult.value;

const taskListResult = buildTool({
  name: "task_list",
  description: "List all tasks on the task board.",
  inputSchema: { type: "object", properties: {} },
  origin: "primordial",
  execute: async (): Promise<unknown> => {
    const items = await taskStore.list();
    return {
      tasks: items.map((i) => ({ id: i.id, description: i.description, status: i.status })),
    };
  },
});
if (!taskListResult.ok) {
  console.error(`buildTool(task_list) failed: ${taskListResult.error.message}`);
  process.exit(1);
}
const taskListTool = taskListResult.value;

// ---------------------------------------------------------------------------
// Memory tools (backed by @koi/core L0 pure functions)
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, string>();

const memoryStoreResult = buildTool({
  name: "memory_store",
  description:
    "Store a memory record. Provide name, description, type (user|feedback|project|reference), and content. Returns the serialized Markdown with frontmatter.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Human-readable name" },
      description: { type: "string", description: "One-line summary" },
      type: {
        type: "string",
        enum: ["user", "feedback", "project", "reference"],
        description: "Memory type",
      },
      content: { type: "string", description: "Memory body content" },
    },
    required: ["name", "description", "type", "content"],
  },
  origin: "primordial",
  execute: async (args: JsonObject): Promise<unknown> => {
    const input = {
      name: String(args.name),
      description: String(args.description),
      type: String(args.type),
      content: String(args.content),
      filePath: `${String(args.name).toLowerCase().replace(/\s+/g, "_")}.md`,
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
    memoryStore.set(input.filePath, serialized);
    return { ok: true, filePath: input.filePath, serialized };
  },
});
if (!memoryStoreResult.ok) {
  console.error(`buildTool(memory_store) failed: ${memoryStoreResult.error.message}`);
  process.exit(1);
}
const memoryStoreTool = memoryStoreResult.value;

const memoryListResult = buildTool({
  name: "memory_list",
  description: "List all stored memory records with their file paths and types.",
  inputSchema: { type: "object", properties: {} },
  origin: "primordial",
  execute: async (): Promise<unknown> => {
    const records = [...memoryStore.entries()].map(([filePath, raw]) => {
      const typeMatch = raw.match(/^type:\s*(.+)$/m);
      const nameMatch = raw.match(/^name:\s*(.+)$/m);
      return { filePath, name: nameMatch?.[1] ?? "unknown", type: typeMatch?.[1] ?? "unknown" };
    });
    return { memories: records };
  },
});
if (!memoryListResult.ok) {
  console.error(`buildTool(memory_list) failed: ${memoryListResult.error.message}`);
  process.exit(1);
}
const memoryListTool = memoryListResult.value;

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
    readonly once?: boolean;
  }[];
  readonly providers: readonly ComponentProvider[];
  /** Max model→tool turns. Default 1. Set to 0 for text-only (no tool loop). */
  readonly maxTurns?: number;
  /** When true, wire hooks through HookRegistry for once-hook lifecycle tracking. */
  readonly useRegistry?: boolean;
  /** Custom permission backend — overrides permissionMode/permissionRules when provided. */
  readonly permissionBackend?: PermissionBackend;
  /** Denial escalation config for permissions middleware. */
  readonly denialEscalation?: boolean | DenialEscalationConfig;
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

  // @koi/hooks — core hook middleware for model pre/post hooks (compact.before/after/blocked)
  const hookResult = loadHooks([...config.hooks]);
  const loadedHooks = hookResult.ok ? hookResult.value : [];
  const coreHookMw = createHookMiddleware({ hooks: loadedHooks });

  // Optional registry for once-hook lifecycle tracking
  // let justified: mutable — created conditionally
  let hookRegistry: ReturnType<typeof createHookRegistry> | undefined;
  if (config.useRegistry === true) {
    hookRegistry = createHookRegistry();
    hookRegistry.register(`golden-${name}`, `golden-${name}`, loadedHooks);
  }

  // Runtime hook dispatch — tool hooks + trajectory recording
  const registrySessionId = `golden-${name}`;
  const hookMw = createHookDispatchMiddleware({
    hooks: loadedHooks,
    store,
    docId,
    ...(hookRegistry !== undefined ? { registry: hookRegistry, registrySessionId } : {}),
  });

  // @koi/permissions + @koi/middleware-permissions
  const permBackend =
    config.permissionBackend ??
    createPermissionBackend({
      mode: config.permissionMode,
      rules: [...config.permissionRules],
    });
  const permMiddleware = createPermissionsMiddleware({
    backend: permBackend,
    description: config.permissionDescription,
    ...(config.denialEscalation !== undefined ? { denialEscalation: config.denialEscalation } : {}),
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

  const tracedMiddleware = [eventTrace, coreHookMw, hookMw, permMiddleware].map((mw) =>
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
  hookRegistry?.cleanup(`golden-${name}`);
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

// ---------------------------------------------------------------------------
// Nexus filesystem (@koi/fs-nexus via real nexus-fs local transport)
// ---------------------------------------------------------------------------

let nexusTransport: { readonly close: () => void } | undefined;
let nexusFsProvider: ComponentProvider | undefined;

// Only set up nexus-fs if nexus-fs Python package is available
const nexusFsCheck = Bun.spawnSync(["python3", "-c", "import nexus.fs"]);
if (nexusFsCheck.exitCode === 0) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const nexusTmpDir = mkdtempSync(join(tmpdir(), "koi-golden-nexus-"));
  const transport = await createLocalTransport({
    mountUri: `local://${nexusTmpDir}`,
    startupTimeoutMs: 15_000,
  });
  nexusTransport = transport;

  const nexusMountPoint = transport.mounts?.[0]?.slice(1) ?? "fs";
  const backend = createNexusFileSystem({
    url: "local://unused",
    mountPoint: nexusMountPoint,
    transport,
  });

  // Pre-seed a file for the LLM to read
  await backend.write("/golden-test.txt", "The answer to the golden query is 42.");

  const readTool = createFsReadTool(backend, "nexus", { sandbox: false });

  nexusFsProvider = createSingleToolProvider({
    name: "nexus-fs",
    toolName: "nexus_read",
    createTool: () => readTool,
  });

  console.log(`Nexus-fs golden query: mount=${nexusMountPoint}, seeded golden-test.txt`);
} else {
  console.log("nexus-fs not available — skipping nexus-fs golden query");
}

// ---------------------------------------------------------------------------
// MCP test server (in-process, real MCP protocol)
// ---------------------------------------------------------------------------

function createTestMcpServer(): McpSdkServer {
  const server = new McpSdkServer(
    { name: "golden-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "weather",
        description: "Get current weather for a city",
        inputSchema: {
          type: "object" as const,
          properties: { city: { type: "string", description: "City name" } },
          required: ["city"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const city = String(args.city ?? "unknown");
    return {
      content: [{ type: "text" as const, text: `Weather in ${city}: 22°C, partly cloudy` }],
    };
  });

  return server;
}

async function createMcpProvider(): Promise<{
  readonly provider: ComponentProvider;
  readonly cleanup: () => Promise<void>;
}> {
  const server = createTestMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);

  const conn = createMcpConnection(
    resolveServerConfig({ kind: "stdio", name: "golden-mcp", command: "echo" }),
    undefined,
    {
      createClient: () => new McpSdkClient({ name: "golden-client", version: "1.0.0" }) as never,
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

  return {
    provider,
    cleanup: async () => {
      resolver.dispose();
      await conn.close();
      await server.close();
    },
  };
}

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

  // 5. denial-escalation: repeated execution-time denials trigger auto-deny escalation
  {
    name: "denial-escalation",
    prompt: "Call the add_numbers tool with a=3 and b=4. Report the result.",
    permissionMode: "default",
    permissionRules: [{ pattern: "*", action: "*", effect: "allow", source: "user" }],
    permissionDescription: "default mode — policy enforcement active",
    permissionBackend: {
      check: (query) =>
        query.resource === "add_numbers"
          ? { effect: "deny" as const, reason: "Policy denies add_numbers" }
          : { effect: "allow" as const },
      checkBatch: (queries) => queries.map(() => ({ effect: "allow" as const })),
    },
    denialEscalation: { threshold: 1, windowMs: 300_000 },
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
    maxTurns: 3,
  },

  // 6. hook-blocked: pre-call hook blocks model call with hook_blocked stopReason
  {
    name: "hook-blocked",
    prompt: "What is 2+2?",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "budget-guard",
        cmd: ["sh", "-c", 'echo \'{"decision":"block","reason":"budget exceeded"}\''],
        filter: { events: ["compact.before"] },
      },
    ],
    providers: [],
    maxTurns: 0,
  },

  // 7. hook-once: once-hook fires on first tool call, absent on second (@koi/hooks once flag)
  {
    name: "hook-once",
    prompt:
      "Use the add_numbers tool to compute 3 + 4, then use it again to compute 10 + 20. Report both results.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "first-tool-guard",
        cmd: ["echo", "once-hook-fired"],
        filter: { events: ["tool.before"] },
        once: true,
      },
      {
        kind: "command",
        name: "always-hook",
        cmd: ["echo", "always-fired"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "add-numbers",
        toolName: "add_numbers",
        createTool: () => addTool,
      }),
    ],
    maxTurns: 3,
    useRegistry: true,
  },

  // 8. web-fetch: @koi/tools-web exercised with real HTTP fetch
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

  // 9. task-board: @koi/tasks exercised — create + list tasks via in-memory store
  {
    name: "task-board",
    prompt:
      'Use the task_create tool to create a task with description "Review the README for typos". Then use the task_list tool to show all tasks.',
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
        name: "task-create",
        toolName: "task_create",
        createTool: () => taskCreateTool,
      }),
      createSingleToolProvider({
        name: "task-list",
        toolName: "task_list",
        createTool: () => taskListTool,
      }),
    ],
    maxTurns: 3,
  },

  // 10. mcp-tool-use: MCP resolver discovers + executes tool from in-process server
  {
    name: "mcp-tool-use",
    prompt: "Use the golden-mcp__weather tool to get the weather in Tokyo. Report the result.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-mcp-tool",
        cmd: ["echo", "mcp-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [], // MCP provider set dynamically below
    maxTurns: 2,
  },

  // 11. turn-stop: stop-gate hook blocks completion, engine re-prompts until maxStopRetries
  {
    name: "turn-stop",
    prompt: "What is the capital of France? Answer concisely.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "completion-gate",
        cmd: ["sh", "-c", 'echo \'{"decision":"block","reason":"verification failed"}\''],
        filter: { events: ["turn.stop"] },
      },
    ],
    providers: [],
    maxTurns: 0,
  },

  // 12. nexus-fs: @koi/fs-nexus exercised via real nexus-fs local transport
  ...(nexusFsProvider !== undefined
    ? [
        {
          name: "nexus-fs-read",
          prompt:
            'Use the nexus_read tool to read the file at path "/golden-test.txt". Tell me what the file says.',
          permissionMode: "bypass" as const,
          permissionRules: BYPASS_RULES,
          permissionDescription: "bypass (allow all)",
          hooks: [
            {
              kind: "command" as const,
              name: "on-fs-tool",
              cmd: ["echo", "fs-tool-done"],
              filter: { events: ["tool.succeeded"] },
            },
          ],
          providers: [nexusFsProvider],
        },
      ]
    : []),

  // 12. memory-store: @koi/memory exercised — store + list memory records via L0 pure functions
  {
    name: "memory-store",
    prompt: MEMORY_STORE_PROMPT,
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
        name: "memory-store",
        toolName: "memory_store",
        createTool: () => memoryStoreTool,
      }),
      createSingleToolProvider({
        name: "memory-list",
        toolName: "memory_list",
        createTool: () => memoryListTool,
      }),
    ],
    maxTurns: 3,
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

await recordCassette("task-board", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: 'Use the task_create tool to create a task with description "Review the README for typos". Then use the task_list tool to show all tasks.',
          },
        ],
      },
    ],
    tools: [taskCreateTool.descriptor, taskListTool.descriptor],
  }),
);

await recordCassette("hook-once", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: "Use the add_numbers tool to compute 3 + 4, then use it again to compute 10 + 20. Report both results.",
          },
        ],
      },
    ],
    tools: [addTool.descriptor],
  }),
);

await recordCassette("memory-store", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: MEMORY_STORE_PROMPT,
          },
        ],
      },
    ],
    tools: [memoryStoreTool.descriptor, memoryListTool.descriptor],
  }),
);

// Inject MCP provider for the mcp-tool-use query (needs async setup)
const mcpSetup = await createMcpProvider();
const mcpQuery = queries.find((q) => q.name === "mcp-tool-use");
if (mcpQuery !== undefined) {
  // Mutate providers for the MCP query (recording-time only)
  (mcpQuery as { providers: ComponentProvider[] }).providers = [mcpSetup.provider];
}

// Also record a cassette for MCP tool-use (model sees the MCP tool)
const mcpToolDescriptors = await mcpSetup.provider.attach({
  pid: { id: "record" as never, name: "record", type: "worker", depth: 0 },
  manifest: {
    name: "record",
    version: "0.0.0",
    model: { name: MODEL },
    tools: [],
    channels: [],
    middleware: [],
  },
  state: "running",
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
} as never);
const mcpTools =
  "components" in mcpToolDescriptors
    ? [...mcpToolDescriptors.components.values()].map(
        (t) =>
          (t as { descriptor: { name: string; description: string; inputSchema: JsonObject } })
            .descriptor,
      )
    : [];

await recordCassette("mcp-tool-use", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: "Use the golden-mcp__weather tool to get the weather in Tokyo. Report the result.",
          },
        ],
      },
    ],
    tools: mcpTools,
  }),
);

// Full-stack ATIF trajectories
for (const q of queries) {
  await recordTrajectory(q);
}

// Cleanup MCP server + nexus transport
await mcpSetup.cleanup();
nexusTransport?.close();

console.log(`\nDone. ${3 + queries.length} fixture files ready:`);
console.log("  fixtures/simple-text.cassette.json");
console.log("  fixtures/tool-use.cassette.json");
console.log("  fixtures/mcp-tool-use.cassette.json");
for (const q of queries) {
  console.log(`  fixtures/${q.name}.trajectory.json`);
}
