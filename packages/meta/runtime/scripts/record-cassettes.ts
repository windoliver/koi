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
 *   hook-redaction       — agent hook on tool.succeeded, forwardRawPayload + default redaction
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

import { createAgentResolver } from "@koi/agent-runtime";
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
  KoiMiddleware,
  MemoryRecord,
  MemoryRecordInput,
  ModelChunk,
  PermissionBackend,
  Result,
  SpawnFn,
} from "@koi/core";
import { createSingleToolProvider, memoryRecordId, sessionId, transcriptEntryId } from "@koi/core";
import { createInMemorySpawnLedger, createKoi, createSpawnToolProvider } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createLocalFileSystem } from "@koi/fs-local";
import { createLocalTransport, createNexusFileSystem } from "@koi/fs-nexus";
import { createHookMiddleware, loadHooks } from "@koi/hooks";
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
import {
  createInMemoryTranscript,
  createSessionTranscriptMiddleware,
  resumeFromTranscript,
} from "@koi/session";
import { createSpawnTools } from "@koi/spawn-tools";
import { createTaskTools } from "@koi/task-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createBashTool } from "@koi/tools-bash";
import { createBuiltinSearchProvider, createFsReadTool } from "@koi/tools-builtin";
import { buildTool } from "@koi/tools-core";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Cassette } from "../src/cassette/types.js";
import { createHookObserver } from "../src/middleware/hook-dispatch.js";
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
// Set RECORD_ONLY=name1,name2 to record only the named queries (comma-separated).
// Useful for re-recording a subset without touching other fixtures.
const RECORD_ONLY_FILTER: ReadonlySet<string> | undefined =
  process.env.RECORD_ONLY !== undefined
    ? new Set(
        process.env.RECORD_ONLY.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : undefined;

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

// get_credentials — returns fake secrets for hook-redaction golden (exercises
// forwardRawPayload + default redaction: API key + password must be stripped
// before the hook agent sees the payload, while the non-secret `host` survives).
const credentialsToolResult = buildTool({
  name: "get_credentials",
  description: "Retrieve database credentials. WARNING: contains sensitive data.",
  inputSchema: { type: "object", properties: {} },
  origin: "primordial",
  // All values here are obviously-fake fixtures, safe to commit. They match
  // the @koi/security/redaction detectors (Anthropic API key prefix +
  // generic password field name) so redaction has something to act on.
  // Do not swap in realistic-looking credentials — the trajectory records
  // raw tool outputs by design, and those artifacts are committed to Git.
  execute: async (): Promise<unknown> => ({
    host: "db.example.com",
    user: "admin",
    password: "super-secret-pw-123",
    apiKey: `sk-ant-api03-${"A".repeat(85)}`,
  }),
});
if (!credentialsToolResult.ok) {
  console.error(`buildTool(get_credentials) failed: ${credentialsToolResult.error.message}`);
  process.exit(1);
}
const credentialsTool = credentialsToolResult.value;

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
    storeWithDedup: (input: MemoryRecordInput, opts: { readonly force: boolean }) => {
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
        } as MemoryRecord;
        records.set(match.id, updated);
        return { ok: true as const, value: { action: "updated" as const, record: updated } };
      }
      counter += 1;
      const id = memoryRecordId(`mem-${counter}`);
      const filePath = `${input.name.toLowerCase().replace(/\s+/g, "_")}.md`;
      const now = Date.now();
      const record: MemoryRecord = { id, ...input, filePath, createdAt: now, updatedAt: now };
      records.set(id, record);
      return { ok: true as const, value: { action: "created" as const, record } };
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
      const wasPresent = records.has(id);
      records.delete(id);
      return { ok: true as const, value: { wasPresent } };
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
const memoryProviderResult = createMemoryToolProvider({
  backend: memoryBackend,
  memoryDir: "/tmp/koi-memory",
});
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
      candidateLimitHit: result.candidateLimitHit,
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
  if (RECORD_ONLY_FILTER !== undefined && !RECORD_ONLY_FILTER.has(name)) {
    console.log(`Skipping ${name}.cassette.json (not in RECORD_ONLY filter)`);
    return;
  }
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
  readonly hooks: readonly (
    | {
        readonly kind: "command";
        readonly name: string;
        readonly cmd: readonly string[];
        readonly filter: { readonly events: readonly string[] };
        readonly once?: boolean;
      }
    | {
        readonly kind: "agent";
        readonly name: string;
        readonly prompt: string;
        readonly model?: string;
        readonly filter: { readonly events: readonly string[] };
        readonly forwardRawPayload?: boolean;
        readonly toolAllowlist?: readonly string[];
        readonly toolDenylist?: readonly string[];
        readonly maxTurns?: number;
        readonly redaction?: {
          readonly enabled?: boolean;
          readonly censor?: "redact" | "mask" | "remove";
          readonly sensitiveFields?: readonly string[];
        };
        readonly once?: boolean;
      }
  )[];
  readonly providers: readonly ComponentProvider[];
  /** Max model→tool turns. Default 1. Set to 0 for text-only (no tool loop). */
  readonly maxTurns?: number;
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
  /**
   * Optional extra middleware to append to the traced middleware chain.
   * Use when a query needs to exercise a specific L2 middleware (e.g. @koi/session:transcript).
   * These are wrapped with wrapMiddlewareWithTrace automatically.
   */
  readonly extraMiddleware?: readonly KoiMiddleware[];
  /**
   * Optional prior messages to seed the conversation before `prompt`.
   * Use for session-resume scenarios where a crashed session's transcript has
   * been converted to InboundMessages via resumeFromTranscript() and should
   * appear as existing context when the agent starts its new turn.
   * When provided, runtime.run() receives { kind: "messages" } with these
   * prepended before a synthetic user message containing `prompt`.
   */
  readonly initialMessages?: readonly import("@koi/core").InboundMessage[];
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

  // @koi/hooks — sole hook dispatcher for all lifecycle events (tool, model, session, turn).
  // Fires tool.before/tool.succeeded/tool.failed with full payload data via its internal
  // registry. The hook observer (below) subscribes to the registry's onExecuted tap for
  // ATIF trajectory recording — no separate dispatch path.
  const hookResult = loadHooks([...config.hooks]);
  const loadedHooks = hookResult.ok ? hookResult.value : [];

  // Captures the userInput each agent hook receives — i.e. the already-redacted
  // payload the sub-agent actually sees. Written to a sidecar file so the
  // golden test can assert redaction actually stripped secrets before they
  // crossed into the hook-agent trust boundary (the tool's raw output still
  // flows to the parent model unredacted — that is by design).
  const capturedHookInputs: {
    readonly hookName: string;
    readonly userInput: string;
    readonly systemPrompt: string | undefined;
  }[] = [];

  // SpawnFn for agent-type hooks. Emulates the structured-output slice of the
  // hook-agent contract: injects request.additionalTools (HookVerdict) into a
  // real LLM call, then extracts the parsed HookVerdict args as the spawn
  // output — exercising the same `requiredOutputToolName` enforcement path
  // the L2 agent executor uses (see packages/lib/hooks/src/agent-executor.ts:245-264).
  //
  // SCOPE: this emulator is intended for hooks whose verification only needs
  // HookVerdict (content-based policies that inspect the payload and decide).
  // It does NOT emulate production's parent-tool inheritance — createAgentExecutor
  // forwards `toolDenylist`/`toolAllowlist` so the child sub-agent inherits
  // parent tools minus safety denies. A hook that investigates via parent
  // tools (grep, fetch, etc.) cannot be recorded with this emulator; use
  // createHookSpawnFn + spawnChildAgent for those.
  const hasAgentHooks = config.hooks.some((h) => h.kind === "agent");
  const hookSpawnFn: SpawnFn | undefined = hasAgentHooks
    ? async (request) => {
        const hookModelAdapter = config.modelAdapter ?? modelAdapter;
        const hookModel = config.modelName ?? MODEL;
        const tools = request.additionalTools ?? [];
        const required = request.requiredOutputToolName;
        // Snapshot the payload the hook agent actually receives. request.description
        // is the already-redacted userInput built by @koi/hooks buildHookPrompts.
        capturedHookInputs.push({
          hookName: request.agentName,
          userInput: request.description,
          systemPrompt: request.systemPrompt,
        });
        const msgs: {
          readonly senderId: string;
          readonly timestamp: number;
          readonly content: readonly { readonly kind: "text"; readonly text: string }[];
        }[] = [
          {
            senderId: "user",
            timestamp: Date.now(),
            content: [{ kind: "text", text: request.description }],
          },
        ];
        try {
          // Honor the hook's requested maxTurns (hook.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
          // resolved by createAgentExecutor and forwarded via SpawnRequest). Mirrors
          // agent-executor.ts retry-on-missing-verdict: the model may produce text
          // first, then be nudged to call HookVerdict on the next turn. Bounded at
          // 2 when the request omits maxTurns, matching the minimal retry budget.
          const maxTurns = request.maxTurns ?? 2;
          for (let turn = 0; turn < maxTurns; turn++) {
            const evts: EngineEvent[] = [];
            for await (const e of consumeModelStream(
              hookModelAdapter.stream({
                messages: msgs,
                model: hookModel,
                tools,
                systemPrompt: request.systemPrompt,
                signal: request.signal,
              }),
              request.signal,
            )) {
              if (e.kind !== "done") evts.push(e);
            }
            const verdict = evts.find((e) => {
              if (e.kind !== "tool_call_end") return false;
              const r = e.result as { readonly toolName: string };
              return r.toolName === required;
            });
            if (verdict?.kind === "tool_call_end") {
              const r = verdict.result as {
                readonly toolName: string;
                readonly parsedArgs?: JsonObject;
              };
              return { ok: true, output: JSON.stringify(r.parsedArgs ?? {}) };
            }
            // Nudge toward HookVerdict on the second turn.
            msgs.push({
              senderId: "user",
              timestamp: Date.now(),
              content: [
                {
                  kind: "text",
                  text: `You must call the ${required ?? "HookVerdict"} tool now with your verdict. Do not respond with text.`,
                },
              ],
            });
          }
          return {
            ok: false,
            error: {
              code: "INTERNAL" as const,
              message: `Hook agent did not call HookVerdict within ${maxTurns} turn(s)`,
              retryable: true,
            },
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: {
              code: "INTERNAL" as const,
              message: `Hook spawn failed: ${message}`,
              retryable: false,
            },
          };
        }
      }
    : undefined;

  // Hook observer — subscribes to @koi/hooks registry's onExecuted tap for
  // ATIF trajectory recording. Does not dispatch hooks itself.
  const { onExecuted: hookObserverTap, middleware: hookObserverMw } = createHookObserver({
    store,
    docId,
  });

  // coreHookMw owns all hooks (including agent hooks). spawnFn is required
  // by createHookMiddleware whenever agent hooks are present. The onExecuted
  // tap wires ATIF recording via the hook observer above.
  const coreHookMw = createHookMiddleware({
    hooks: loadedHooks,
    ...(hookSpawnFn !== undefined ? { spawnFn: hookSpawnFn } : {}),
    onExecuted: hookObserverTap,
  });

  // @koi/permissions + @koi/middleware-permissions
  const permBackend =
    config.permissionBackend ??
    createPermissionBackend({
      mode: config.permissionMode,
      rules: [...config.permissionRules],
    });
  const permHandle = createPermissionsMiddleware({
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
      const maxTurns = config.maxTurns ?? 1;
      const msgs: {
        readonly senderId: string;
        readonly timestamp: number;
        readonly content: readonly { readonly kind: "text"; readonly text: string }[];
        readonly metadata?: JsonObject;
      }[] = [];
      // Seed conversation from input: text prompt → single user message;
      // messages input (e.g., stop-gate retry with feedback) → preserve
      // all messages so the model sees the retry context instead of an
      // empty conversation (#1493 anomaly fix).
      if (input.kind === "messages") {
        for (const m of input.messages) {
          const text = m.content
            .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
            .map((c) => c.text)
            .join("");
          msgs.push({
            senderId: m.senderId,
            timestamp: m.timestamp,
            content: [{ kind: "text", text }],
            ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
          });
        }
      } else {
        const text = input.kind === "text" ? input.text : "";
        msgs.push({ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] });
      }
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
    hookObserverMw,
    exfiltrationGuard,
    permHandle,
    semanticRetryMw,
    ...(config.extraMiddleware ?? []),
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

  // Hook registration is handled internally by createHookMiddleware — hooks are
  // registered per session in onSessionStart and cleaned up in onSessionEnd.

  const runInput: import("@koi/core").EngineInput =
    config.initialMessages !== undefined
      ? {
          kind: "messages",
          messages: [
            ...config.initialMessages,
            {
              senderId: "user",
              timestamp: Date.now(),
              content: [{ kind: "text", text: prompt }],
            },
          ],
        }
      : { kind: "text", text: prompt };
  for await (const _e of runtime.run(runInput)) {
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

  // Side-car: agent-hook inputs (what the hook sub-agents actually saw).
  // Used by goldens that need to assert redaction applied *before* payloads
  // crossed into the hook-agent trust boundary.
  //
  // Written unconditionally when the query declares agent hooks — an empty
  // inputs array is a *signal* that this recording did not exercise the
  // hook-agent path, which the replay test asserts on. Skipping the write
  // would leave a stale sidecar from a previous (passing) recording, letting
  // a regression go green against old evidence.
  if (hasAgentHooks) {
    await Bun.write(
      `${FIXTURES}/${name}.hook-inputs.json`,
      JSON.stringify({ name, capturedAt: Date.now(), inputs: capturedHookInputs }, null, 2),
    );
  }

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

  // Path allowlist: only approved system directories may be listed.
  // This prevents the recording model from enumerating arbitrary host paths via ls args.
  const _SANDBOXED_PATH_ALLOWLIST = new Set(["/usr/bin", "/bin", "/usr/local/bin"]);

  const _runSandboxedResult = buildTool({
    name: "run_sandboxed",
    description:
      "List files inside a sandboxed system directory. Network access is disabled. Only /usr/bin, /bin, and /usr/local/bin are allowed paths. Provide the directory path to list.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to a system directory to list. Allowed: /usr/bin, /bin, /usr/local/bin",
        },
      },
      required: ["path"],
    },
    origin: "primordial",
    execute: async (args: JsonObject): Promise<unknown> => {
      const dirPath = String(args.path);
      if (!_SANDBOXED_PATH_ALLOWLIST.has(dirPath)) {
        // Throw so the framework marks this as tool.failed — not a silent success.
        throw new Error(
          `Path not permitted: ${dirPath}. Allowed: ${[..._SANDBOXED_PATH_ALLOWLIST].join(", ")}`,
        );
      }
      const instance = await _sandboxAdapter.create(_sandboxProfile);
      try {
        // Hardcode the command — model only controls which approved directory to list.
        // ls binary location varies by platform; try /bin/ls then /usr/bin/ls.
        const lsBin = (await Bun.file("/bin/ls").exists()) ? "/bin/ls" : "/usr/bin/ls";
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
        const r = await instance.exec(lsBin, ["-1", dirPath], {
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

// Built-ins only — cassette recording must be hermetic. Project-local .koi/agents/ overrides
// would bake local untracked state into fixtures, making cassettes non-reproducible.
const { resolver: spawnResolver } = createAgentResolver();
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
  //
  // Backend models a two-stage enterprise authorization: `checkBatch` is the
  // cheap catalog-advertising stage used at tool-filter time (answers "is this
  // tool listed in the caller's catalog?"), while `check` is the expensive
  // per-invocation policy stage that also consults request-scoped context like
  // args, rate limits, or session-level risk signals. Because these two stages
  // answer different questions, they can legitimately produce different
  // decisions for the same resource — this is how real ABAC/ReBAC backends
  // (OPA, OpenFGA, Cedar) are commonly wired.
  //
  // In this fixture:
  //   - catalog stage (checkBatch): add_numbers is in the catalog → allow
  //   - invocation stage (check):    per-call policy denies add_numbers → deny
  // The model therefore sees the tool, attempts to call it, and the
  // wrapToolCall gate denies with a realistic execution-time reason. This
  // exercises the denial-escalation path (#1493).
  //
  // Both paths are derived from single-arrow named functions so the
  // asymmetry is explicit and auditable — no hidden state, no cross-stage
  // contradiction dressed up as policy equivalence.
  {
    name: "denial-escalation",
    prompt: "Call the add_numbers tool with a=3 and b=4. Report the result.",
    permissionMode: "default",
    permissionRules: [{ pattern: "*", action: "*", effect: "allow", source: "user" }],
    permissionDescription: "tool catalog",
    permissionBackend: {
      // Invocation stage: full per-call policy evaluation.
      check: (query) =>
        query.resource === "add_numbers"
          ? {
              effect: "deny" as const,
              reason: "add_numbers invocation denied by per-call policy",
            }
          : { effect: "allow" as const },
      // Catalog stage: cheap visibility check, tool advertised to callers.
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

  // spawn-fork: fork mode — parent calls Spawn(fork=true), child inherits parent tools BUT
  //   NOT Spawn. The recursion guard in create-agent-spawn-fn.ts suppresses the Spawn provider
  //   for fork children (!isFork check), and applyForkDenylist adds "Spawn" to the denylist
  //   as defense-in-depth. Forked children are scoped to do work, not further delegation.
  //   maxTurns defaults to DEFAULT_FORK_MAX_TURNS (200) since fork=true and no explicit maxTurns.
  //   Uses Gemini Flash — only one Spawn tool call needed, not a 3+ chain, so Flash is reliable.
  {
    name: "spawn-fork",
    prompt:
      "You have Glob, Grep, ToolSearch, and Spawn tools. " +
      "Use the Spawn tool with agentName='researcher' and fork=true to delegate: " +
      "'List your available tools by name. Do you have a Spawn tool? Answer yes or no.' " +
      "Then report the researcher's answer verbatim.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [],
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

  // spawn-coordinator: coordinator self-ceiling + allowlist — when coordinator is spawned,
  //   its manifest selfCeiling restricts it to delegation-only tools regardless of parent.
  //   Parent spawns the built-in coordinator. Coordinator only receives:
  //   [Spawn, task_create, task_list, task_output, task_delegate, task_stop, send_message].
  //   It should NOT receive Glob, Grep, ToolSearch or other parent capabilities.
  //   Proves the coordinator's selfCeiling and COORDINATOR_TOOL_ALLOWLIST ceiling are enforced.
  //   Uses Gemini Flash — only one Spawn tool call needed, so Flash is reliable here.
  {
    name: "spawn-coordinator",
    prompt:
      "You have Glob, Grep, ToolSearch, and Spawn tools. " +
      "Use the Spawn tool with agentName='coordinator' to delegate: " +
      "'List your available tools by name.' " +
      "Then report which tools the coordinator listed.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [],
    maxTurns: 2,
    providerFactory: (store, docId) => {
      const { middleware: childEventTrace } = createEventTraceMiddleware({
        store,
        docId,
        agentName: "coordinator",
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
            "Use the run_sandboxed tool to list the files in /usr/bin. Report the path you listed and how many executables were found.",
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

  // bash-exec: @koi/tools-bash — Bash tool with security classifiers
  {
    name: "bash-exec",
    prompt: 'Use the Bash tool to run the command "echo hello-from-bash" and tell me the output.',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-bash-tool",
        cmd: ["echo", "bash-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "bash",
        toolName: "Bash",
        createTool: () => createBashTool({ workspaceRoot: process.cwd() }),
      }),
    ],
    maxTurns: 2,
  },

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

  // hook-redaction: agent hook on tool.succeeded with forwardRawPayload + default redaction.
  //   Parent calls get_credentials which returns a mix of secrets (apiKey, password)
  //   and a safe field (host). The @koi/hooks redaction pipeline masks secrets
  //   before forwarding the payload to the secret-scanner agent hook. The hook
  //   spawns a sub-agent that MUST call HookVerdict (injected via additionalTools)
  //   and should return ok=true — the redacted payload is safe. With a passing
  //   verdict, the parent then reports the `host` field back to the user.
  {
    name: "hook-redaction",
    prompt:
      "Use the get_credentials tool to retrieve the database credentials. Report the host name.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "agent" as const,
        name: "secret-scanner",
        prompt:
          "Verify the tool output does not contain any exposed secrets or credentials. " +
          "If the payload shows redaction markers (e.g. [REDACTED], ***, or masked fields) and no raw secrets, " +
          "call HookVerdict with ok=true. If you see an unredacted API key or password, call HookVerdict with ok=false.",
        filter: { events: ["tool.succeeded"] },
        forwardRawPayload: true,
        // Narrow this content-policy hook to HookVerdict only — matches what
        // the recording SpawnFn passes to the LLM (additionalTools only). In
        // production createAgentExecutor filters HookVerdict out of the
        // allowlist (see buildToolConstraints) and injects it via
        // additionalTools, so the child sub-agent still gets HookVerdict.
        // Result: production and the recorder exercise the same tool surface.
        toolAllowlist: ["HookVerdict"],
        // Single turn: the LLM either emits HookVerdict on its first reply
        // or the hook fails closed. Matches the "must call HookVerdict
        // exactly once" contract and keeps the recorder's retry budget aligned
        // with production.
        maxTurns: 1,
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "credentials",
        toolName: "get_credentials",
        createTool: () => credentialsTool,
      }),
    ],
    maxTurns: 2,
    // Gemini 2.0 Flash's safety layer sometimes refuses prompts mentioning
    // "credentials" even for benign (clearly fictitious) tool calls, making
    // trajectory re-recording non-deterministic. Sonnet 4.6 follows the
    // tool-use instructions reliably here.
    modelAdapter: sonnetAdapter,
    modelName: SONNET_MODEL,
  },

  // @koi/session — session-persist: transcript middleware exercises session transcript append
  // during model call. wrapMiddlewareWithTrace captures it as MW:@koi/session:transcript step.
  {
    name: "session-persist",
    prompt: "What is 2+2? Reply with just the number.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [],
    extraMiddleware: [
      createSessionTranscriptMiddleware({
        transcript: createInMemoryTranscript(),
        sessionId: sessionId("golden-session-persist"),
      }),
    ],
  },

  // @koi/session — session-resume: exercises crash recovery + resumeFromTranscript().
  // A prior session had a tool call that completed (add_numbers: 3+7=10), which was
  // written to a transcript. The session then "crashed". On restart, resumeFromTranscript()
  // converts those transcript entries into InboundMessages and they are injected as
  // prior context via initialMessages. The agent resumes mid-conversation, sees the
  // prior tool_call/tool_result pair, and continues by calling add_numbers again.
  // Trajectory proves: (1) resume messages appear in model context, (2) session
  // transcript MW fires on the new turn, (3) compact boundary extension is exercised.
  (() => {
    // Simulate the crashed session's transcript
    const crashedTranscript = [
      {
        id: transcriptEntryId("crash-e1"),
        role: "user" as const,
        content: "Use add_numbers to compute 3 + 7.",
        timestamp: Date.now() - 60000,
      },
      {
        id: transcriptEntryId("crash-e2"),
        role: "tool_call" as const,
        content: JSON.stringify([
          { id: "call-crashed-01", toolName: "add_numbers", args: '{"a":3,"b":7}' },
        ]),
        timestamp: Date.now() - 59000,
      },
      {
        id: transcriptEntryId("crash-e3"),
        role: "tool_result" as const,
        content: '{"result":10}',
        timestamp: Date.now() - 58500,
      },
      {
        id: transcriptEntryId("crash-e4"),
        role: "assistant" as const,
        content: "The result of 3 + 7 is 10.",
        timestamp: Date.now() - 58000,
      },
    ];

    // resumeFromTranscript converts the crashed transcript to InboundMessages
    const resumeResult = resumeFromTranscript(crashedTranscript);
    const resumeMessages = resumeResult.ok ? resumeResult.value.messages : [];

    const resumeTranscript = createInMemoryTranscript();
    return {
      name: "session-resume",
      prompt:
        "The previous session crashed mid-conversation. " +
        "You previously used add_numbers to compute 3+7=10. " +
        "Now use add_numbers to compute 15 + 25. Report both results.",
      permissionMode: "bypass" as const,
      permissionRules: BYPASS_RULES,
      permissionDescription: "bypass (allow all)",
      hooks: [],
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
      ],
      maxTurns: 2,
      initialMessages: resumeMessages,
      extraMiddleware: [
        createSessionTranscriptMiddleware({
          transcript: resumeTranscript,
          sessionId: sessionId("golden-session-resume"),
        }),
      ],
    };
  })(),
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

// hook-redaction uses Sonnet 4.6 — Gemini 2.0 Flash's safety layer is flaky
// on prompts mentioning "credentials" and sometimes refuses the tool call.
await recordCassette(
  "hook-redaction",
  () =>
    sonnetAdapter.stream({
      messages: [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [
            {
              kind: "text",
              text: "Use the get_credentials tool to retrieve the database credentials. Report the host name.",
            },
          ],
        },
      ],
      tools: [credentialsTool.descriptor],
    }),
  { model: SONNET_MODEL },
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

// hook-redaction uses Sonnet 4.6 — Gemini 2.0 Flash's safety layer is flaky
// on prompts mentioning "credentials" and sometimes refuses the tool call.
await recordCassette(
  "hook-redaction",
  () =>
    sonnetAdapter.stream({
      messages: [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [
            {
              kind: "text",
              text: "Use the get_credentials tool to retrieve the database credentials. Report the host name.",
            },
          ],
        },
      ],
      tools: [credentialsTool.descriptor],
    }),
  { model: SONNET_MODEL },
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
  if (RECORD_ONLY_FILTER !== undefined && !RECORD_ONLY_FILTER.has(q.name)) {
    console.log(`Skipping ${q.name}.trajectory.json (not in RECORD_ONLY filter)`);
    continue;
  }
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
console.log("  fixtures/hook-redaction.cassette.json");
console.log("  fixtures/mcp-tool-use.cassette.json");
for (const q of queries) {
  console.log(`  fixtures/${q.name}.trajectory.json`);
}
