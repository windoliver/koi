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
 *   @koi/fs-local             — local filesystem backend
 */

import {
  createAgentDefinitionRegistry,
  createDefinitionResolver,
  getBuiltInAgents,
} from "@koi/agent-runtime";
import type {
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  FileListResult,
  FileReadResult,
  FileSystemBackend,
  JsonObject,
  KoiError,
  MemoryRecord,
  MemoryRecordInput,
  ModelChunk,
  PermissionBackend,
  Result,
  SpawnFn,
} from "@koi/core";
import { createSingleToolProvider, memoryRecordId } from "@koi/core";
import { createInMemorySpawnLedger, createKoi, createSpawnToolProvider } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createLocalFileSystem } from "@koi/fs-local";
import { createLocalTransport, createNexusFileSystem } from "@koi/fs-nexus";
import { createHookMiddleware, createHookRegistry, loadHooks } from "@koi/hooks";
import {
  createMcpComponentProvider,
  createMcpConnection,
  createMcpResolver,
  createTransportStateMachine,
  resolveServerConfig,
} from "@koi/mcp";
import { recallMemories } from "@koi/memory";
import type { MemoryToolBackend } from "@koi/memory-tools";
import { createMemoryToolProvider } from "@koi/memory-tools";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import type { DenialEscalationConfig } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import {
  createRetrySignalBroker,
  createSemanticRetryMiddleware,
} from "@koi/middleware-semantic-retry";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream, runTurn } from "@koi/query-engine";
import { createOsAdapter, restrictiveProfile } from "@koi/sandbox-os";
import { createSpawnTools } from "@koi/spawn-tools";
import { createTaskTools } from "@koi/task-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
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

// Set FORCE_RECORD=true to re-record cassettes that already exist.
// By default, existing cassettes are skipped — this prevents recordedAt +
// callId churn in every PR that happens to run the script, which causes
// spurious merge conflicts on fixture files.
const FORCE_RECORD = process.env.FORCE_RECORD === "true";

const modelAdapter = createOpenAICompatAdapter({
  apiKey: API_KEY,
  baseUrl: "https://openrouter.ai/api/v1",
  model: MODEL,
  retry: { maxRetries: 1 },
});

// Sonnet 4.6 adapter — used for cassettes that need reliable multi-step
// tool call streaming (Gemini 2.0 Flash drops function name tokens on the
// 3rd+ tool call in a sequence, producing "unknown" in ATIF trajectories).
const SONNET_MODEL = "anthropic/claude-sonnet-4-6";
const sonnetAdapter = createOpenAICompatAdapter({
  apiKey: API_KEY,
  baseUrl: "https://openrouter.ai/api/v1",
  model: SONNET_MODEL,
  retry: { maxRetries: 1 },
});

// ---------------------------------------------------------------------------
// Shared prompts (reused for both cassette + trajectory recording)
// ---------------------------------------------------------------------------

const MEMORY_STORE_PROMPT =
  'Use the memory_store tool to store a feedback memory with name "testing approach", description "always write failing tests first", type "feedback", and content "Rule: write failing tests before implementation.\\n**Why:** catches regressions early.\\n**How to apply:** TDD workflow for all new features.". Then use the memory_recall tool with query "testing" to retrieve it. Finally use the memory_search tool with type "feedback" to search for feedback memories.';

const MEMORY_RECALL_PROMPT =
  "Use the memory_recall tool to recall all persisted memories for session start. Report what memories were found, how many were selected, and whether the recall was truncated or degraded.";

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

// send_message — tool with a string field for exfiltration guard testing
const sendMessageToolResult = buildTool({
  name: "send_message",
  description: "Send a message to the user",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", description: "The message text to send" } },
    required: ["message"],
  },
  origin: "primordial",
  execute: async (args: JsonObject): Promise<unknown> => ({
    sent: true,
    message: args.message,
  }),
});
if (!sendMessageToolResult.ok) {
  console.error(`buildTool failed: ${sendMessageToolResult.error.message}`);
  process.exit(1);
}
const sendMessageTool = sendMessageToolResult.value;

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
// @koi/task-tools — full tool surface (7 tools via createTaskTools)
// ---------------------------------------------------------------------------

const taskToolsBoard = await createManagedTaskBoard({
  store: createMemoryTaskBoardStore(),
});
const taskToolsAll = createTaskTools({
  board: taskToolsBoard,
  agentId: "golden-recorder" as import("@koi/core").AgentId,
});
// createTaskTools returns [create, get, update, list, stop, output, delegate]
const [ttCreate, ttGet, ttUpdate, ttList, ttStop, ttOutput, ttDelegate] = taskToolsAll as [
  import("@koi/core").Tool,
  import("@koi/core").Tool,
  import("@koi/core").Tool,
  import("@koi/core").Tool,
  import("@koi/core").Tool,
  import("@koi/core").Tool,
  import("@koi/core").Tool,
];

// ---------------------------------------------------------------------------
// @koi/spawn-tools — agent_spawn tool with stub SpawnFn
// Stub returns immediately without launching a real child agent.
// The cassette captures the LLM's tool-call interaction pattern.
// ---------------------------------------------------------------------------

const stubSpawnFn: SpawnFn = async (request) => ({
  ok: true,
  output: `Task delegated to ${request.agentName}: ${request.description} — result: done`,
});

const spawnToolsAbortController = new AbortController();
const spawnToolsAll = createSpawnTools({
  spawnFn: stubSpawnFn,
  board: taskToolsBoard, // shares the task board for full coordinator flow
  agentId: "golden-recorder" as import("@koi/core").AgentId,
  signal: spawnToolsAbortController.signal,
});
// createSpawnTools returns [agent_spawn]
const [stAgentSpawn] = spawnToolsAll as [import("@koi/core").Tool];

// ---------------------------------------------------------------------------
// Memory tools (backed by @koi/memory-tools with in-memory backend)
// ---------------------------------------------------------------------------

function createInMemoryMemoryBackend(): MemoryToolBackend {
  const records = new Map<string, MemoryRecord>();
  let counter = 0;

  return {
    store: (input: MemoryRecordInput) => {
      counter += 1;
      const id = memoryRecordId(`mem-${counter}`);
      const filePath = `${input.name.toLowerCase().replace(/\s+/g, "_")}.md`;
      const now = Date.now();
      const record: MemoryRecord = { id, ...input, filePath, createdAt: now, updatedAt: now };
      records.set(id, record);
      return { ok: true as const, value: record };
    },
    recall: (_query, _options) => {
      return { ok: true as const, value: [...records.values()] };
    },
    search: (filter) => {
      const all = [...records.values()];
      const filtered = filter.type !== undefined ? all.filter((r) => r.type === filter.type) : all;
      return { ok: true as const, value: filtered };
    },
    delete: (id) => {
      records.delete(id);
      return { ok: true as const, value: undefined };
    },
    findByName: (name, type) => {
      const match = [...records.values()].find(
        (r) => r.name === name && (type === undefined || r.type === type),
      );
      return { ok: true as const, value: match };
    },
    get: (id) => {
      return { ok: true as const, value: records.get(id) };
    },
    update: (id, patch) => {
      const existing = records.get(id);
      if (existing === undefined)
        return {
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
        };
      const updated = { ...existing, ...patch, updatedAt: Date.now() } as MemoryRecord;
      records.set(id, updated);
      return { ok: true as const, value: updated };
    },
  };
}

const memoryBackend = createInMemoryMemoryBackend();
const memoryProviderResult = createMemoryToolProvider({ backend: memoryBackend });
if (!memoryProviderResult.ok) {
  console.error(`createMemoryToolProvider failed: ${memoryProviderResult.error.message}`);
  process.exit(1);
}
const memoryProvider = memoryProviderResult.value;

// Extract tool descriptors for cassette recording (need to attach to a mock agent)
const memoryAttachResult = await memoryProvider.attach(
  {} as Parameters<typeof memoryProvider.attach>[0],
);
const memoryComponents =
  "components" in memoryAttachResult ? memoryAttachResult.components : memoryAttachResult;
const memoryToolDescriptors = [...memoryComponents.values()]
  .filter(
    (
      v,
    ): v is {
      readonly descriptor: {
        readonly name: string;
        readonly description: string;
        readonly inputSchema: JsonObject;
      };
    } => typeof v === "object" && v !== null && "descriptor" in v,
  )
  .map((t) => t.descriptor);

// ---------------------------------------------------------------------------
// Memory recall tool (backed by @koi/memory recallMemories + in-memory FS)
// ---------------------------------------------------------------------------

const recallMemoryFiles = new Map<string, { content: string; modifiedAt: number }>([
  [
    "/memories/user_role.md",
    {
      content: [
        "---",
        "name: User role",
        "description: Senior engineer with Go expertise",
        "type: user",
        "---",
        "",
        "Deep Go expertise, new to React and this project's frontend.",
      ].join("\n"),
      modifiedAt: Date.now() - 2 * 86_400_000,
    },
  ],
  [
    "/memories/testing_feedback.md",
    {
      content: [
        "---",
        "name: Testing feedback",
        "description: always write failing tests first",
        "type: feedback",
        "---",
        "",
        "Rule: write failing tests before implementation.",
        "**Why:** catches regressions early.",
        "**How to apply:** TDD workflow for all new features.",
      ].join("\n"),
      modifiedAt: Date.now() - 5 * 86_400_000,
    },
  ],
  [
    "/memories/project_goal.md",
    {
      content: [
        "---",
        "name: Project goal",
        "description: ship v2 by Q2 2026",
        "type: project",
        "---",
        "",
        "v2 rewrite targeting Q2 2026. Merge freeze begins 2026-03-05.",
      ].join("\n"),
      modifiedAt: Date.now() - 10 * 86_400_000,
    },
  ],
]);

const recallMockFs: FileSystemBackend = {
  name: "recall-mock-fs",
  read(path): Result<FileReadResult, KoiError> {
    const file = recallMemoryFiles.get(path);
    if (!file) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `not found: ${path}`, retryable: false },
      };
    }
    return { ok: true, value: { content: file.content, path, size: file.content.length } };
  },
  list(path): Result<FileListResult, KoiError> {
    const entries = [...recallMemoryFiles.entries()]
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
      error: { code: "INTERNAL" as const, message: "read-only", retryable: false },
    };
  },
  edit() {
    return {
      ok: false,
      error: { code: "INTERNAL" as const, message: "read-only", retryable: false },
    };
  },
  search() {
    return {
      ok: false,
      error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
    };
  },
};

const memoryRecallResult = buildTool({
  name: "memory_recall",
  description:
    "Recall persisted memories for session start. Scans the memory directory, scores by salience, selects within token budget, and returns formatted memories.",
  inputSchema: { type: "object", properties: {} },
  origin: "primordial",
  execute: async (): Promise<unknown> => {
    const result = await recallMemories(recallMockFs, {
      memoryDir: "/memories",
      tokenBudget: 8000,
      now: Date.now(),
    });
    return {
      selected: result.selected.length,
      totalScanned: result.totalScanned,
      truncated: result.truncated,
      degraded: result.degraded,
      skippedFiles: result.skippedFiles,
      totalTokens: result.totalTokens,
      formatted: result.formatted,
    };
  },
});
if (!memoryRecallResult.ok) {
  console.error(`buildTool(memory_recall) failed: ${memoryRecallResult.error.message}`);
  process.exit(1);
}
const memoryRecallTool = memoryRecallResult.value;

// =========================================================================
// Recording helpers
// =========================================================================

async function recordCassette(
  name: string,
  factory: () => AsyncIterable<ModelChunk>,
  options: { readonly model?: string } = {},
): Promise<void> {
  const path = `${FIXTURES}/${name}.cassette.json`;
  if (!FORCE_RECORD && (await Bun.file(path).exists())) {
    console.log(
      `Skipping ${name}.cassette.json (already exists — set FORCE_RECORD=true to re-record)`,
    );
    return;
  }
  const cassModel = options.model ?? MODEL;
  console.log(`Recording ${name}.cassette.json (model: ${cassModel})...`);
  const chunks: ModelChunk[] = [];
  for await (const c of factory()) chunks.push(c);
  await Bun.write(
    path,
    JSON.stringify(
      { name, model: cassModel, recordedAt: Date.now(), chunks } satisfies Cassette,
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
  /** Override model adapter for this query's trajectory recording. Defaults to global modelAdapter. */
  readonly modelAdapter?: ReturnType<typeof createOpenAICompatAdapter>;
  /** Model name to use when modelAdapter is overridden. Defaults to MODEL constant. */
  readonly modelName?: string;
  /**
   * Optional factory called after the ATIF store is created.
   * Replaces `providers` for queries that need to inject store-aware middleware
   * into child agents (e.g., spawn inheritance with shared trajectory store).
   * When provided, `providers` is ignored.
   */
  readonly providerFactory?: (
    store: ReturnType<typeof createAtifDocumentStore>,
    docId: string,
  ) => readonly ComponentProvider[];
  /**
   * Optional parent manifest overrides merged into the default `{ name, version, model }`.
   * Use to set manifest.spawn ceiling on the parent agent for manifest-ceiling queries.
   */
  readonly parentManifestOverrides?: import("@koi/core").AgentManifest;
}

// ---------------------------------------------------------------------------
// Full-stack trajectory recorder
// ---------------------------------------------------------------------------

async function recordTrajectory(config: QueryConfig): Promise<void> {
  const { name, prompt } = config;
  const path = `${FIXTURES}/${name}.trajectory.json`;
  if (!FORCE_RECORD && (await Bun.file(path).exists())) {
    console.log(
      `Skipping ${name}.trajectory.json (already exists — set FORCE_RECORD=true to re-record)`,
    );
    return;
  }
  console.log(`\nRecording ${name}.trajectory.json (full-stack, all L2)...`);

  const trajDir = `/tmp/koi-record-${name}-${Date.now()}`;
  const docId = name;
  const store = createAtifDocumentStore(
    { agentName: `golden-${name}` },
    createFsAtifDelegate(trajDir),
  );

  // @koi/middleware-semantic-retry — broker created early so event-trace can read signals
  const retryBroker = createRetrySignalBroker();

  // @koi/event-trace
  const { middleware: eventTrace } = createEventTraceMiddleware({
    store,
    docId,
    agentName: `golden-${name}`,
    signalReader: retryBroker,
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

  // Bridge adapter — use per-query override if provided (e.g. Sonnet for multi-step tool calls)
  const queryModelAdapter = config.modelAdapter ?? modelAdapter;
  const queryModel = config.modelName ?? MODEL;
  const bridge: EngineAdapter = {
    engineId: `golden-${name}`,
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: { modelCall: queryModelAdapter.complete, modelStream: queryModelAdapter.stream },
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
              ? h.modelStream({ messages: msgs, model: queryModel })
              : (async function* (): AsyncIterable<ModelChunk> {
                  const r = await h.modelCall({ messages: msgs, model: queryModel });
                  yield {
                    kind: "done" as const,
                    response: { content: r.content, model: queryModel },
                  };
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
            // Append assistant message (the tool-use intent).
            // Include both callName (request-mapper session-repair) and toolName
            // (legacy key) so both Gemini and Sonnet can reconstruct tool_calls.
            msgs.push({
              senderId: "assistant",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "" }],
              metadata: {
                callId: realCallId,
                callName: r.toolName,
                callArgs: JSON.stringify(r.parsedArgs ?? {}),
                toolName: r.toolName,
              } as JsonObject,
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
                // callId + toolCallId: both keys so any provider path finds the linkage.
                metadata: {
                  callId: realCallId,
                  toolCallId: realCallId,
                  toolName: r.toolName,
                } as JsonObject,
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

  // @koi/middleware-exfiltration-guard — secret exfiltration scanning (priority 50, before permissions)
  const exfiltrationGuard = createExfiltrationGuardMiddleware({ action: "block" });

  // @koi/middleware-semantic-retry — writer side (broker created above with event-trace)
  const { middleware: semanticRetryMw } = createSemanticRetryMiddleware({
    signalWriter: retryBroker,
  });

  const tracedMiddleware = [
    eventTrace,
    coreHookMw,
    hookMw,
    exfiltrationGuard,
    permMiddleware,
    semanticRetryMw,
  ].map((mw) => wrapMiddlewareWithTrace(mw, { store, docId }));

  // Resolve providers: factory takes precedence when present (e.g., spawn-inheritance
  // needs to inject a child-scoped eventTrace into spawnToolProvider.inheritedMiddleware
  // so the child's model calls appear in the same ATIF document with their own identity).
  const resolvedProviders =
    config.providerFactory !== undefined ? config.providerFactory(store, docId) : config.providers;

  const runtime = await createKoi({
    manifest: {
      name: `golden-${name}`,
      version: "0.1.0",
      model: { name: queryModel },
      ...config.parentManifestOverrides,
    },
    adapter: bridge,
    middleware: tracedMiddleware,
    providers: [...resolvedProviders],
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
// @koi/sandbox-os — run_sandboxed: executes arbitrary commands inside OS sandbox
// Only enabled on supported platforms (macOS seatbelt, Linux bwrap).
//
// Design: the sandbox PROFILE is server-side config — LLM supplies only the
// command path and its arguments. Restrictions (network disabled, credential
// paths denied via restrictiveProfile) are enforced by the server, never by
// the caller.
// ---------------------------------------------------------------------------

let sandboxProvider: import("@koi/core").ComponentProvider | undefined;

const _sandboxAdapterResult = createOsAdapter();
if (_sandboxAdapterResult.ok) {
  const _sandboxAdapter = _sandboxAdapterResult.value;

  // Profile is config: network off + credential paths read-denied.
  // LLM never controls which paths are blocked or whether network is allowed.
  const _sandboxProfile = restrictiveProfile();

  // Command allowlist: only safe, read-only inspection commands are permitted.
  // This prevents the recording model from exfiltrating host files via /bin/cat, find, etc.
  // The golden query only needs ls, so this set is intentionally minimal.
  const _SANDBOXED_ALLOWLIST = new Set(["/bin/ls", "/usr/bin/ls", "/bin/echo", "/bin/date"]);

  const _runSandboxedResult = buildTool({
    name: "run_sandboxed",
    description:
      "Execute an allowed read-only command inside the OS sandbox. Only /bin/ls, /bin/echo, and /bin/date are permitted. Network access is disabled. Provide the executable path and its arguments.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Absolute path to the executable. Allowed: /bin/ls, /bin/echo, /bin/date",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments",
        },
      },
      required: ["command"],
    },
    origin: "primordial",
    execute: async (args: JsonObject): Promise<unknown> => {
      const cmd = String(args.command);
      if (!_SANDBOXED_ALLOWLIST.has(cmd)) {
        return {
          error: `Command not permitted: ${cmd}`,
          allowed: [..._SANDBOXED_ALLOWLIST],
        };
      }
      const instance = await _sandboxAdapter.create(_sandboxProfile);
      try {
        const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
        // Scrub inherited env so the recorder's OPENROUTER_API_KEY and other secrets are
        // not visible inside the sandbox. Only pass a minimal allowlist.
        const safeEnv: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          TERM: "dumb",
          LANG: process.env.LANG ?? "en_US.UTF-8",
        };
        // Hard 10-second wall-clock cap — prevents a blocking command from wedging the recorder.
        const r = await instance.exec(cmd, cmdArgs, {
          env: safeEnv,
          timeoutMs: 10_000,
        });
        const stdout = r.stdout.trim();
        // Only emit entry_count when output is complete — truncated output yields a partial
        // count that is misleading for audit purposes. Callers should rerun with a narrower
        // command or check `truncated` before trusting the count.
        const entryCount =
          !r.truncated && r.exitCode === 0 && stdout.length > 0
            ? stdout.split("\n").filter((l) => l.trim()).length
            : undefined;
        return {
          stdout,
          stderr: r.stderr.trim(),
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          ...(r.truncated === true ? { truncated: true } : {}),
          ...(r.signal !== undefined ? { signal: r.signal } : {}),
          ...(entryCount !== undefined ? { entry_count: entryCount } : {}),
          platform: _sandboxAdapter.platform.platform,
        };
      } finally {
        await instance.destroy();
      }
    },
  });

  if (_runSandboxedResult.ok) {
    const _runSandboxedTool = _runSandboxedResult.value;
    sandboxProvider = createSingleToolProvider({
      name: "run-sandboxed",
      toolName: "run_sandboxed",
      createTool: () => _runSandboxedTool,
    });
  } else {
    console.warn(`buildTool(run_sandboxed) failed: ${_runSandboxedResult.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Nexus filesystem (@koi/fs-nexus via real nexus-fs local transport)
// ---------------------------------------------------------------------------

let nexusTransport: { readonly close: () => void } | undefined;
let nexusFsProvider: ComponentProvider | undefined;

// Only set up nexus-fs if nexus-fs Python package is available AND transport starts cleanly
const nexusFsCheck = Bun.spawnSync(["python3", "-c", "import nexus.fs"]);
if (nexusFsCheck.exitCode === 0) {
  try {
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
  } catch (err: unknown) {
    console.log(
      `nexus-fs transport failed (${err instanceof Error ? err.message : String(err)}) — skipping`,
    );
    nexusTransport = undefined;
    nexusFsProvider = undefined;
  }
} else {
  console.log("nexus-fs not available — skipping nexus-fs golden query");
}

// ---------------------------------------------------------------------------
// Local filesystem (@koi/fs-local — no Nexus server needed)
// ---------------------------------------------------------------------------

const { mkdtempSync } = await import("node:fs");
const { tmpdir: tmpDirFn } = await import("node:os");
const { join: joinPath } = await import("node:path");

const localFsTmpDir = mkdtempSync(joinPath(tmpDirFn(), "koi-golden-local-fs-"));
const localFsBackend = createLocalFileSystem(localFsTmpDir);

// Pre-seed a file for the LLM to read
await localFsBackend.write("golden-local.txt", "The local filesystem answer is 7.");

const localReadTool = createFsReadTool(localFsBackend, "local_fs", { sandbox: false });
const localFsProvider = createSingleToolProvider({
  name: "local-fs",
  toolName: "local_fs_read",
  createTool: () => localReadTool,
});

console.log(`Local-fs golden query: dir=${localFsTmpDir}, seeded golden-local.txt`);

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

// ---------------------------------------------------------------------------
// Spawn tool provider — @koi/agent-runtime + @koi/engine (#1424)
// Child agents use a proper EngineAdapter built with runTurn() so the
// model→tool→model loop works correctly inside spawnChildAgent/createKoi.
// ---------------------------------------------------------------------------

/**
 * Wraps modelAdapter into a full EngineAdapter for spawned child agents.
 * Uses runTurn() from @koi/query-engine to drive the model loop.
 * The parent bridge adapter is for recording; children need their own loop.
 */
function createChildBridge(): EngineAdapter {
  return {
    engineId: "spawn-child",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: { modelCall: modelAdapter.complete, modelStream: modelAdapter.stream },
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
              metadata: { error: "No callHandlers on child agent input" },
            },
          };
        })();
      }
      const text = input.kind === "text" ? input.text : "";
      const messages = [
        { senderId: "user", timestamp: Date.now(), content: [{ kind: "text" as const, text }] },
      ];
      return runTurn({ callHandlers: h, messages, signal: input.signal });
    },
  };
}

const spawnBuiltIns = getBuiltInAgents();
const spawnRegistry = createAgentDefinitionRegistry(spawnBuiltIns, []);
const spawnResolver = createDefinitionResolver(spawnRegistry);
const spawnToolProvider = createSpawnToolProvider({
  resolver: spawnResolver,
  spawnLedger: createInMemorySpawnLedger(5),
  adapter: createChildBridge(), // child agents use a proper engine adapter with runTurn
  manifestTemplate: {
    name: "spawned-agent",
    version: "0.0.0",
    description: "Spawned sub-agent",
    model: { name: MODEL },
  },
});

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

  // 8. local-fs: @koi/fs-local exercised via real local filesystem
  {
    name: "local-fs-read",
    prompt:
      'Use the local_fs_read tool to read the file at path "golden-local.txt". Tell me what the file says.',
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-local-fs-tool",
        cmd: ["echo", "local-fs-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [localFsProvider],
  },

  // 12. memory-store: @koi/memory-tools exercised — store, recall, search via L2 package
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
    providers: [memoryProvider],
    maxTurns: 5,
  },

  // 13. memory-recall: @koi/memory recallMemories exercised — scan, score, budget, format
  {
    name: "memory-recall",
    prompt: MEMORY_RECALL_PROMPT,
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
        name: "memory-recall",
        toolName: "memory_recall",
        createTool: () => memoryRecallTool,
      }),
    ],
    maxTurns: 2,
  },

  // 14. exfiltration-guard-block: @koi/middleware-exfiltration-guard blocks tool arg with encoded secret
  {
    name: "exfiltration-guard-block",
    prompt: `Use the send_message tool with message set to exactly this string: ${btoa("AKIAIOSFODNN7EXAMPLE")}. Do not modify or decode it, just pass it as-is.`,
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
        name: "send-message",
        toolName: "send_message",
        createTool: () => sendMessageTool,
      }),
    ],
  },

  // 15. spawn-agent: Spawn tool exercises @koi/agent-runtime built-in resolver (#1424)
  //     Parent delegates to built-in "researcher" agent via the Spawn tool.
  //     Trajectory: parent model call → Spawn tool → child researcher agent (real LLM) → result back.
  {
    name: "spawn-agent",
    prompt:
      "Use the Spawn tool with agentName='researcher' to delegate this task: " +
      "'What is the Fibonacci sequence? Provide a one-sentence definition.' " +
      "Then report the researcher's answer verbatim.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [spawnToolProvider],
    maxTurns: 2, // turn 0: parent calls Spawn; turn 1: parent reports result
  },

  // 14. spawn-allowlist: toolAllowlist via Spawn tool (#1425)
  //     Parent has Glob + Grep + ToolSearch + Spawn.
  //     Parent spawns researcher with toolAllowlist=['Grep'] — child gets ONLY Grep + Spawn.
  //     Glob and ToolSearch absent from child's ModelRequest.tools proves allowlist enforcement.
  {
    name: "spawn-allowlist",
    prompt:
      "You have Glob, Grep, ToolSearch, and Spawn tools. " +
      "Use the Spawn tool with agentName='researcher' and toolAllowlist=['Grep'] to delegate: " +
      "'List your available tools by name, then answer: what is 2+2?' " +
      "Then report the researcher's answer.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [], // unused — providerFactory takes precedence
    maxTurns: 2,
    providerFactory: (store, docId) => {
      const { middleware: childEventTrace } = createEventTraceMiddleware({
        store,
        docId,
        agentName: "researcher",
      });
      return [
        createBuiltinSearchProvider({ cwd: process.cwd() }),
        createSpawnToolProvider({
          resolver: spawnResolver,
          spawnLedger: createInMemorySpawnLedger(5),
          adapter: createChildBridge(),
          manifestTemplate: {
            name: "spawned-agent",
            version: "0.0.0",
            description: "Spawned sub-agent",
            model: { name: MODEL },
          },
          inheritedMiddleware: [childEventTrace],
        }),
      ];
    },
  },

  // 15. spawn-manifest-ceiling: manifest.spawn.tools.policy=allowlist (#1425)
  //     Parent manifest declares spawn.tools.policy=allowlist, list=['Grep'].
  //     LLM calls Spawn with NO toolAllowlist — manifest ceiling enforced by engine alone.
  //     Child model step should show only [Grep] (Glob and ToolSearch absent).
  //     Proves ceiling is enforced at the engine level, not by caller discipline.
  {
    name: "spawn-manifest-ceiling",
    prompt:
      "You have Glob, Grep, ToolSearch, and Spawn tools. " +
      "Use the Spawn tool with agentName='researcher' to delegate (do NOT set toolAllowlist): " +
      "'List your available tools by name, then answer: what is 2+2?' " +
      "Then report the researcher's answer.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [], // unused — providerFactory takes precedence
    maxTurns: 2,
    // Parent manifest declares the ceiling — only Grep allowed for children
    parentManifestOverrides: {
      name: "golden-spawn-manifest-ceiling",
      version: "0.1.0",
      model: { name: MODEL },
      spawn: { tools: { policy: "allowlist", list: ["Grep"] } },
    },
    providerFactory: (store, docId) => {
      const { middleware: childEventTrace } = createEventTraceMiddleware({
        store,
        docId,
        agentName: "researcher",
      });
      return [
        createBuiltinSearchProvider({ cwd: process.cwd() }),
        createSpawnToolProvider({
          resolver: spawnResolver,
          spawnLedger: createInMemorySpawnLedger(5),
          adapter: createChildBridge(),
          manifestTemplate: {
            name: "spawned-agent",
            version: "0.0.0",
            description: "Spawned sub-agent",
            model: { name: MODEL },
          },
          inheritedMiddleware: [childEventTrace],
        }),
      ];
    },
  },

  // 17. spawn-inheritance: tool narrowing via toolDenylist (#1425)
  //     Parent has Glob + Grep + ToolSearch (builtin search) + Spawn.
  //     Parent spawns researcher with toolDenylist=['Glob'] — child inherits Grep + ToolSearch
  //     but NOT Glob, and gets a fresh Spawn. Child's model call appears in the shared ATIF
  //     document with agentName="researcher", proving Glob is absent at the model-request level.
  {
    name: "spawn-inheritance",
    prompt:
      "You have Glob, Grep, ToolSearch, and Spawn tools. " +
      "Use the Spawn tool with agentName='researcher' and toolDenylist=['Glob'] to delegate: " +
      "'List your available tools by name, then answer: what is 2+2?' " +
      "Then report the researcher's answer.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [], // unused — providerFactory takes precedence
    maxTurns: 2,
    providerFactory: (store, docId) => {
      // Child event trace: same store + docId as parent, child's own identity.
      // Child steps appear in the trajectory tagged "researcher", making
      // ModelRequest.tools visible — Glob absent proves denylist enforcement.
      const { middleware: childEventTrace } = createEventTraceMiddleware({
        store,
        docId,
        agentName: "researcher",
      });
      return [
        // Parent has Glob + Grep + ToolSearch so the denylist has something to deny
        createBuiltinSearchProvider({ cwd: process.cwd() }),
        createSpawnToolProvider({
          resolver: spawnResolver,
          spawnLedger: createInMemorySpawnLedger(5),
          adapter: createChildBridge(),
          manifestTemplate: {
            name: "spawned-agent",
            version: "0.0.0",
            description: "Spawned sub-agent",
            model: { name: MODEL },
          },
          inheritedMiddleware: [childEventTrace],
        }),
      ];
    },
  },

  // task-tools: @koi/task-tools — full 6-tool surface via createTaskTools()
  //     Exercises create → list → update(in_progress) → update(completed) flow.
  {
    name: "task-tools",
    // Prompt intentionally limited to task_create + task_list only.
    // Gemini 2.0 Flash generates malformed args for task_update in multi-step
    // scenarios (parsedArgs → undefined → silently dropped by bridge adapter).
    // The task_update/stop/output flows are tested in the 48 unit tests.
    // This golden query validates that the tool pipeline is wired correctly.
    prompt:
      "Use the task_create tool to create two tasks: " +
      "one with subject 'Implement login flow' and description 'Build OAuth2', " +
      "and another with subject 'Write API tests' and description 'Add integration tests'. " +
      "Then use task_list to show all tasks. Report how many tasks were created.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-task-tool",
        cmd: ["echo", "task-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "task-create",
        toolName: "task_create",
        createTool: () => ttCreate,
      }),
      createSingleToolProvider({ name: "task-get", toolName: "task_get", createTool: () => ttGet }),
      createSingleToolProvider({
        name: "task-update",
        toolName: "task_update",
        createTool: () => ttUpdate,
      }),
      createSingleToolProvider({
        name: "task-list",
        toolName: "task_list",
        createTool: () => ttList,
      }),
      createSingleToolProvider({
        name: "task-stop",
        toolName: "task_stop",
        createTool: () => ttStop,
      }),
      createSingleToolProvider({
        name: "task-output",
        toolName: "task_output",
        createTool: () => ttOutput,
      }),
      createSingleToolProvider({
        name: "task-delegate",
        toolName: "task_delegate",
        createTool: () => ttDelegate,
      }),
    ],
    maxTurns: 5,
  },

  // sandbox-exec: @koi/sandbox-os — run_sandboxed tool validates Seatbelt/bwrap triggers
  //   agent calls run_sandboxed with command+args → sandbox executes the command → ATIF captures output
  //   Profile is server-side config (restrictiveProfile). LLM supplies only command + args.
  //   Only included when platform detection succeeds (macOS or Linux).
  ...(sandboxProvider !== undefined
    ? [
        {
          name: "sandbox-exec",
          prompt:
            "Use the run_sandboxed tool to list the files in /usr/bin. Report what command you ran and how many executables were found.",
          permissionMode: "bypass" as const,
          permissionRules: BYPASS_RULES,
          permissionDescription: "bypass (allow all)",
          hooks: [
            {
              kind: "command" as const,
              name: "on-sandbox-tool",
              cmd: ["echo", "sandbox-tool-done"],
              filter: { events: ["tool.succeeded"] },
            },
          ],
          providers: [sandboxProvider],
          maxTurns: 2,
        },
      ]
    : []),

  // 15. spawn-tools: @koi/spawn-tools — agent_spawn tool with stub SpawnFn
  //     Coordinator creates a task, delegates it, then spawns a child agent.
  //     Stub SpawnFn returns immediately (no real child agent launched).
  {
    name: "spawn-tools",
    prompt:
      "You are a coordinator. Do the following steps in order: " +
      "1) Use task_create to create a task with subject 'Research caching strategies' and description 'Investigate Redis vs Memcached'. " +
      "2) Use task_delegate to assign that task to agent 'researcher'. " +
      "3) Use agent_spawn with agent_name='researcher', description='Research Redis vs Memcached caching strategies', and the task_id from step 1. " +
      "Report the researcher's output.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
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
    maxTurns: 4,
    // Use Sonnet 4.6 for trajectory recording — Gemini 2.0 Flash drops the
    // function name token on the 3rd+ tool call in a sequence (completion_tokens: 1),
    // causing agent_spawn to resolve as "unknown" in the ATIF.
    modelAdapter: sonnetAdapter,
    modelName: SONNET_MODEL,
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

await recordCassette("task-tools", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text:
              "Use the task_create tool to create two tasks: " +
              "one with subject 'Implement login flow' and description 'Build OAuth2', " +
              "and another with subject 'Write API tests' and description 'Add integration tests'. " +
              "Then use task_list to show all tasks. Report how many tasks were created.",
          },
        ],
      },
    ],
    tools: [
      ttCreate.descriptor,
      ttGet.descriptor,
      ttUpdate.descriptor,
      ttList.descriptor,
      ttStop.descriptor,
      ttOutput.descriptor,
      ttDelegate.descriptor,
    ],
  }),
);

// spawn-tools uses Sonnet 4.6 — Gemini 2.0 Flash drops function name tokens
// on the 3rd+ tool call in a sequence, causing agent_spawn to emit as "unknown".
await recordCassette(
  "spawn-tools",
  () =>
    sonnetAdapter.stream({
      messages: [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [
            {
              kind: "text",
              text:
                "You are a coordinator. Do the following steps in order: " +
                "1) Use task_create to create a task with subject 'Research caching strategies' and description 'Investigate Redis vs Memcached'. " +
                "2) Use task_delegate to assign that task to agent 'researcher'. " +
                "3) Use agent_spawn with agent_name='researcher', description='Research Redis vs Memcached caching strategies', and the task_id from step 1. " +
                "Report the researcher's output.",
            },
          ],
        },
      ],
      tools: [ttCreate.descriptor, ttDelegate.descriptor, stAgentSpawn.descriptor],
    }),
  { model: SONNET_MODEL },
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
    tools: memoryToolDescriptors,
  }),
);

await recordCassette("memory-recall", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: MEMORY_RECALL_PROMPT,
          },
        ],
      },
    ],
    tools: [memoryRecallTool.descriptor],
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

console.log(`\nDone. ${4 + queries.length} fixture files ready:`);
console.log("  fixtures/simple-text.cassette.json");
console.log("  fixtures/tool-use.cassette.json");
console.log("  fixtures/task-tools.cassette.json");
console.log("  fixtures/spawn-tools.cassette.json");
console.log("  fixtures/mcp-tool-use.cassette.json");
for (const q of queries) {
  console.log(`  fixtures/${q.name}.trajectory.json`);
}
