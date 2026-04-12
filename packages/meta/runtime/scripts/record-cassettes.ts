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
 *   @koi/tools-builtin        — Glob/Grep/ToolSearch + TodoWrite/plan-mode interaction tools
 *   @koi/fs-local             — local filesystem backend
 *   @koi/skills-runtime       — skill discovery + SkillComponent attach
 *   @koi/outcome-evaluator    — LLM-as-judge rubric iteration loop
 */

import { createAgentResolver } from "@koi/agent-runtime";
import type {
  Agent,
  AuditEntry,
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
import { createEventTraceMiddleware, createMonotonicClock } from "@koi/event-trace";
import { createLocalFileSystem } from "@koi/fs-local";
import { createLocalTransport, createNexusFileSystem } from "@koi/fs-nexus";
import { createHookMiddleware, loadHooks } from "@koi/hooks";
import type { LspClient } from "@koi/lsp";
import { createLspTools } from "@koi/lsp";
import {
  createMcpComponentProvider,
  createMcpConnection,
  createMcpResolver,
  createTransportStateMachine,
  resolveServerConfig,
} from "@koi/mcp";
import { createMcpServer } from "@koi/mcp-server";
import { recallMemories } from "@koi/memory";
import type { MemoryToolBackend } from "@koi/memory-tools";
import { createMemoryToolProvider } from "@koi/memory-tools";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import { createGoalMiddleware } from "@koi/middleware-goal";
import type { DenialEscalationConfig } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import {
  createRetrySignalBroker,
  createSemanticRetryMiddleware,
} from "@koi/middleware-semantic-retry";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type { ProviderAdapter } from "@koi/model-router";
import {
  createModelRouter,
  createModelRouterMiddleware,
  validateRouterConfig,
} from "@koi/model-router";
import { createOutcomeEvaluatorMiddleware } from "@koi/outcome-evaluator";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import {
  createPluginRegistry,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  removePlugin,
  validatePluginManifest,
} from "@koi/plugins";
import { consumeModelStream, runTurn } from "@koi/query-engine";
import { createOsAdapter, restrictiveProfile } from "@koi/sandbox-os";
import {
  createInMemoryTranscript,
  createSessionTranscriptMiddleware,
  resumeFromTranscript,
} from "@koi/session";
import { createSkillTool } from "@koi/skill-tool";
import {
  createSkillInjectorMiddleware,
  createSkillProvider,
  createSkillsRuntime,
} from "@koi/skills-runtime";
import { createSpawnTools } from "@koi/spawn-tools";
import { createTaskTools } from "@koi/task-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import {
  createBrowserProvider,
  createBrowserSnapshotTool,
  createMockDriver,
} from "@koi/tool-browser";
import type { NotebookToolConfig } from "@koi/tool-notebook";
import { createNotebookAddCellTool, createNotebookReadTool } from "@koi/tool-notebook";
import { createBashBackgroundTool, createBashTool } from "@koi/tools-bash";
import {
  createAskUserTool,
  createBuiltinSearchProvider,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createFsReadTool,
  createGlobTool,
  createTodoTool,
} from "@koi/tools-builtin";
import { buildTool } from "@koi/tools-core";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Cassette } from "../src/cassette/types.js";
import { createInteractionProvider } from "../src/create-interaction-provider.js";
import { createHookObserver } from "../src/middleware/hook-dispatch.js";
import { recordMcpLifecycle } from "../src/middleware/mcp-lifecycle.js";
import { wrapMiddlewareWithTrace } from "../src/middleware/trace-wrapper.js";
import { createSkillsMcpBridge } from "../src/skills-mcp-bridge.js";
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
// Task tools — removed hand-built stubs; task-board query now uses real createTaskTools

// ---------------------------------------------------------------------------
// @koi/tools-builtin interaction tools — TodoWrite descriptor for cassette
// ---------------------------------------------------------------------------

// Dummy backing store — only used to extract descriptors for cassette recording.
// The actual in-memory state lives in createInteractionProvider() at query time.
// let: mutable ref for setItems callback (immutable replacement pattern)
let _todoItemsForDescriptor: readonly import("@koi/tools-builtin").TodoItem[] = [];
const todoToolForCassette = createTodoTool({
  getItems: () => _todoItemsForDescriptor,
  setItems: (items) => {
    _todoItemsForDescriptor = items;
  },
});
// let: mutable plan-mode flag used only for descriptor extraction
let _planModeForDescriptor = false;
const enterPlanModeToolForCassette = createEnterPlanModeTool({
  isAgentContext: () => false,
  isInPlanMode: () => _planModeForDescriptor,
  enterPlanMode: () => {
    _planModeForDescriptor = true;
  },
});
const exitPlanModeToolForCassette = createExitPlanModeTool({
  isInPlanMode: () => _planModeForDescriptor,
  isTeammate: false,
  isPlanModeRequired: false,
  exitPlanMode: () => {
    _planModeForDescriptor = false;
  },
  getPlanContent: async () => undefined,
});
const askUserToolForCassette = createAskUserTool({
  elicit: async () => [],
});

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

// task-board query uses a separate ManagedTaskBoard with real createTaskTools
// (distinct from the taskToolsBoard used by the task-tools query above)
const taskBoardBoard = await createManagedTaskBoard({
  store: createMemoryTaskBoardStore(),
});
const taskBoardTools = createTaskTools({
  board: taskBoardBoard,
  agentId: "golden-recorder" as import("@koi/core").AgentId,
});
const taskBoardToolProviders = taskBoardTools.map((tool) =>
  createSingleToolProvider({
    name: `task-board-${tool.descriptor.name}`,
    toolName: tool.descriptor.name,
    createTool: () => tool,
  }),
);

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
  /**
   * Optional callback invoked after the trajectory (and any other sidecars) are written.
   * Use to write additional sidecar files that capture state from the run
   * (e.g., audit entries captured by a custom sink during the session).
   */
  readonly afterRecord?: (fixtures: string, name: string) => Promise<void>;
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
  const clock = createMonotonicClock();

  // @koi/middleware-semantic-retry — broker created early so event-trace can read signals
  const retryBroker = createRetrySignalBroker();

  // @koi/event-trace
  const { middleware: eventTrace } = createEventTraceMiddleware({
    store,
    docId,
    agentName: `golden-${name}`,
    clock,
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
    clock,
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
    clock,
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

  // @koi/middleware-goal — objective tracking (fires decisions on injection turns)
  const goalMw = createGoalMiddleware({
    objectives: [config.prompt.slice(0, 120)],
  });

  // @koi/skills-runtime — skill-injector (fires decisions when skills are attached)
  // Lazy agent ref: middleware created before createKoi, agent wired after assembly.
  const agentRef: { current?: Agent } = {};
  const skillInjectorMw = createSkillInjectorMiddleware({
    agent: (): Agent => {
      if (agentRef.current === undefined) throw new Error("Agent not yet wired");
      return agentRef.current;
    },
  });

  const tracedMiddleware = [
    eventTrace,
    coreHookMw,
    hookObserverMw,
    exfiltrationGuard,
    permHandle,
    goalMw,
    skillInjectorMw,
    semanticRetryMw,
    ...(config.extraMiddleware ?? []),
  ].map((mw) => wrapMiddlewareWithTrace(mw, { store, docId, clock }));

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

  // Wire the lazy agent ref now that assembly is complete.
  agentRef.current = runtime.agent;

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

  if (config.afterRecord !== undefined) {
    await config.afterRecord(FIXTURES, name);
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
// @koi/sandbox-os — sandboxed Bash: OS sandbox injected into createBashTool (DI pattern).
// Only enabled on supported platforms (macOS seatbelt, Linux bwrap).
//
// Design: the sandbox adapter and restrictive profile are L3 server-side config —
// the model calls the ordinary Bash tool; the sandbox is transparent to it.
// ---------------------------------------------------------------------------

let sandboxedBashProvider: ComponentProvider | undefined;

const _sandboxAdapterResult = createOsAdapter();
if (_sandboxAdapterResult.ok) {
  const _sandboxAdapter = _sandboxAdapterResult.value;
  const _sandboxProfile = restrictiveProfile();
  sandboxedBashProvider = createSingleToolProvider({
    name: "bash",
    toolName: "Bash",
    createTool: () =>
      createBashTool({
        workspaceRoot: process.cwd(),
        sandboxAdapter: _sandboxAdapter,
        sandboxProfile: _sandboxProfile,
      }),
  });
}

// ---------------------------------------------------------------------------
// @koi/tools-bash bash_background + task polling tools
// ---------------------------------------------------------------------------
// Separate task board scoped to the background recording so tasks don't
// bleed across queries.
const bgTaskBoard = await createManagedTaskBoard({
  store: createMemoryTaskBoardStore(),
});
const bgAgentId = "golden-bg-agent" as import("@koi/core").AgentId;
const bashBackgroundProvider = createSingleToolProvider({
  name: "bash-background",
  toolName: "bash_background",
  createTool: () =>
    createBashBackgroundTool({
      taskBoard: bgTaskBoard,
      agentId: bgAgentId,
      workspaceRoot: process.cwd(),
    }),
});
const bgTaskToolsAll = createTaskTools({ board: bgTaskBoard, agentId: bgAgentId });
const [, bgTtGet, , bgTtList, , bgTtOutput] = bgTaskToolsAll as import("@koi/core").Tool[];

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
// @koi/skills-runtime — skill discovery + SkillComponent attach
// Seeded with a "bullet-points" skill (with tags) that the agent is asked to follow.
// Tests progressive loading: discover() reads frontmatter (name, description, tags)
// without loading body; load() promotes to SkillDefinition with body + scan.
// ---------------------------------------------------------------------------

const skillsTmpDir = mkdtempSync(joinPath(tmpDirFn(), "koi-golden-skills-"));
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(joinPath(skillsTmpDir, "bullet-points"), { recursive: true });
writeFileSync(
  joinPath(skillsTmpDir, "bullet-points", "SKILL.md"),
  [
    "---",
    "name: bullet-points",
    "description: Respond using bullet points instead of prose.",
    "tags:",
    "  - formatting",
    "  - style",
    "---",
    "",
    "Always respond using bullet point lists. Never use prose paragraphs.",
  ].join("\n"),
);

// Verify progressive loading: discover() returns SkillMetadata with tags (no body)
const skillRuntime = createSkillsRuntime({ bundledRoot: null, userRoot: skillsTmpDir });
const discoverResult = await skillRuntime.discover();
if (!discoverResult.ok) throw new Error(`Skill discover failed: ${discoverResult.error.message}`);
const meta = discoverResult.value.get("bullet-points");
if (!meta) throw new Error("bullet-points not discovered");
if (!meta.tags?.includes("formatting")) {
  throw new Error(`Expected tags to include "formatting", got: ${JSON.stringify(meta.tags)}`);
}
console.log(
  `Skills progressive loading verified: name=${meta.name}, tags=${JSON.stringify(meta.tags)}, body absent=true`,
);

// Verify registry query: filter by tag
const queryResult = await skillRuntime.query({ tags: ["formatting"] });
if (!queryResult.ok) throw new Error(`Skill query failed: ${queryResult.error.message}`);
if (queryResult.value.length !== 1 || queryResult.value[0]?.name !== "bullet-points") {
  throw new Error(
    `Expected query to return bullet-points, got: ${JSON.stringify(queryResult.value.map((s) => s.name))}`,
  );
}
console.log(
  `Skills registry query verified: tags=["formatting"] → [${queryResult.value.map((s) => s.name).join(", ")}]`,
);

const skillProvider = createSkillProvider(skillRuntime);
console.log(`Skills golden query: dir=${skillsTmpDir}, skill=bullet-points`);

// ---------------------------------------------------------------------------
// @koi/skill-tool — SkillTool meta-tool golden query setup
// Uses the same skillRuntime to create a Skill tool the model can invoke.
// ---------------------------------------------------------------------------

const skillToolResult = await createSkillTool({
  resolver: skillRuntime,
  signal: AbortSignal.timeout(300_000),
});
if (!skillToolResult.ok) {
  throw new Error(`createSkillTool failed: ${skillToolResult.error.message}`);
}
const skillTool = skillToolResult.value;
const skillToolProvider = createSingleToolProvider({
  name: "skill-tool",
  toolName: "Skill",
  createTool: () => skillTool,
});
console.log(
  `SkillTool golden query: Skill tool created, advertising ${discoverResult.value.size} skill(s)`,
);

// ---------------------------------------------------------------------------
// @koi/tool-notebook setup
// ---------------------------------------------------------------------------

const NOTEBOOK_FIXTURE = `${FIXTURES}/golden-notebook.ipynb`;
const notebookConfig: NotebookToolConfig = {};
const notebookReadTool = createNotebookReadTool(notebookConfig);
const notebookAddCellTool = createNotebookAddCellTool(notebookConfig);

// Copy fixture to a temp path so notebook-add-cell doesn't mutate the committed fixture
const notebookTmpPath = `/tmp/koi-golden-notebook-${Date.now()}.ipynb`;
await Bun.write(notebookTmpPath, await Bun.file(NOTEBOOK_FIXTURE).text());

// ---------------------------------------------------------------------------
// @koi/tool-browser setup (mock driver — no real browser for golden queries)
// ---------------------------------------------------------------------------

const goldenMockDriver = createMockDriver();
const goldenBrowserPolicy = { sandbox: false, capabilities: {} } as const;
const browserProvider = createBrowserProvider({
  backend: goldenMockDriver,
  prefix: "browser",
  policy: goldenBrowserPolicy,
});
// Standalone tool for cassette descriptor extraction
const browserSnapshotForCassette = createBrowserSnapshotTool(
  goldenMockDriver,
  "browser",
  goldenBrowserPolicy,
);

// ---------------------------------------------------------------------------
// @koi/lsp setup (mock client — no real LSP server for golden queries)
// ---------------------------------------------------------------------------

const goldenLspClient: LspClient = {
  capabilities: () => ({
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
  }),
  hover: async (_uri, _line, _char) => ({
    ok: true as const,
    value: {
      contents: {
        kind: "markdown" as const,
        value: "```typescript\nfunction greet(name: string): string\n```\nSays hello.",
      },
      range: {
        start: { line: _line, character: _char },
        end: { line: _line, character: _char + 5 },
      },
    },
  }),
  gotoDefinition: async (_uri, _line, _char) => ({
    ok: true as const,
    value: [
      {
        uri: "file:///src/greet.ts",
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 20 } },
      },
    ],
  }),
  findReferences: async () => ({
    ok: true as const,
    value: [
      {
        uri: "file:///src/main.ts",
        range: { start: { line: 5, character: 2 }, end: { line: 5, character: 7 } },
      },
      {
        uri: "file:///src/test.ts",
        range: { start: { line: 12, character: 4 }, end: { line: 12, character: 9 } },
      },
    ],
  }),
  documentSymbols: async () => ({
    ok: true as const,
    value: [
      {
        name: "greet",
        kind: 12,
        location: {
          uri: "file:///src/greet.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
        },
      },
    ],
  }),
  workspaceSymbols: async () => ({
    ok: true as const,
    value: [
      {
        name: "greet",
        kind: 12,
        location: {
          uri: "file:///src/greet.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
        },
      },
    ],
  }),
  openDocument: async () => ({ ok: true as const, value: undefined }),
  closeDocument: async () => ({ ok: true as const, value: undefined }),
  getDiagnostics: () => new Map(),
  close: async () => {},
  isConnected: () => true,
  serverName: () => "golden-lsp",
} as unknown as LspClient;

const lspTools = createLspTools(goldenLspClient, "golden-lsp");
const lspToolProvider: ComponentProvider = {
  name: "lsp-golden",
  attach: async () => {
    const components = new Map<string, unknown>();
    for (const tool of lspTools) {
      components.set(`tool:${tool.descriptor.name}`, tool);
    }
    return { components, skipped: [] };
  },
};

// ---------------------------------------------------------------------------
// Skills-MCP bridge setup (reuses MCP server tools as skills via bridge)
// ---------------------------------------------------------------------------

// Create a separate skill runtime for the bridge test (no filesystem skills)
const bridgeSkillRuntime = createSkillsRuntime({ bundledRoot: null });

// Bridge will be wired after MCP provider is created (needs resolver)
// See the skills-mcp-bridge query injection below the MCP provider setup

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

// ---------------------------------------------------------------------------
// @koi/model-router — two-target config: failing primary → real secondary
// Primary always throws so the trajectory shows fallback_occurred:true.
// ---------------------------------------------------------------------------

const modelRouterPrimary: ProviderAdapter = {
  id: "primary-down",
  async complete(): Promise<import("@koi/core").ModelResponse> {
    throw new Error("primary unavailable (intentional for fallback recording)");
  },
  stream(): AsyncGenerator<import("@koi/core").ModelChunk> {
    throw new Error("primary unavailable (intentional for fallback recording)");
  },
};

const modelRouterSecondary: ProviderAdapter = {
  id: "openrouter",
  complete: (req) => modelAdapter.complete(req),
  stream: (req) => modelAdapter.stream(req),
};

const modelRouterConfigResult = validateRouterConfig({
  strategy: "fallback",
  targets: [
    { provider: "primary-down", model: "fast-primary", adapterConfig: {} },
    { provider: "openrouter", model: MODEL, adapterConfig: {} },
  ],
  retry: { maxRetries: 0 },
});
if (!modelRouterConfigResult.ok) {
  console.error(`model-router config: ${modelRouterConfigResult.error.message}`);
  process.exit(1);
}
const modelRouter = createModelRouter(
  modelRouterConfigResult.value,
  new Map([
    ["primary-down", modelRouterPrimary],
    ["openrouter", modelRouterSecondary],
  ]),
);
const modelRouterMiddleware = createModelRouterMiddleware(modelRouter);

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

  // 9. task-board: @koi/tasks + @koi/task-tools exercised — create + list via real createTaskTools
  {
    name: "task-board",
    prompt:
      'Use the task_create tool to create a task with subject "Review README" and description "Review the README for typos". Then use the task_list tool to show all tasks.',
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
    providers: taskBoardToolProviders,
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

  // todo-write: @koi/tools-builtin interaction tools — TodoWrite via createInteractionProvider
  //   LLM writes a two-item todo list; ATIF captures the tool step and cleared=false result.
  {
    name: "todo-write",
    prompt:
      "Use the TodoWrite tool to create a to-do list with two tasks: " +
      "first 'Write unit tests' with status 'in_progress', " +
      "and second 'Write documentation' with status 'pending'. " +
      "After calling the tool, report how many tasks are now in the list.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-todo-write",
        cmd: ["echo", "todo-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [createInteractionProvider()],
    maxTurns: 2,
  },

  // plan-mode: @koi/tools-builtin — realistic plan → explore → complete → exit flow
  //   1. EnterPlanMode  2. TodoWrite (2 tasks: explore + plan)
  //   3. Glob to explore (completes 'explore' task)  4. TodoWrite (explore done, plan in_progress)
  //   5. TodoWrite (plan done → auto-clear)  6. ExitPlanMode
  {
    name: "plan-mode",
    prompt:
      "You are planning how to add a new feature to this repo. Follow these steps:\n" +
      "1. Call EnterPlanMode.\n" +
      "2. Call TodoWrite with two tasks: id='explore' content='Explore the repo structure' status='in_progress', " +
      "and id='write-plan' content='Write the implementation plan' status='pending'.\n" +
      "3. Call Glob with pattern='package.json' to explore the repo (this is the exploration work).\n" +
      "4. Call TodoWrite to mark 'explore' completed and 'write-plan' in_progress.\n" +
      "5. Call TodoWrite to mark 'write-plan' completed (auto-clear will fire).\n" +
      "6. Call ExitPlanMode.\n" +
      "Report what you found during exploration and confirm the plan was approved.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-plan-tool",
        cmd: ["echo", "plan-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [createInteractionProvider(), createBuiltinSearchProvider({ cwd: process.cwd() })],
    maxTurns: 8,
  },

  // interaction-full: ALL interaction tools + task_delegate + agent_spawn in one coordinator flow
  //   AskUserQuestion → EnterPlanMode → TodoWrite(3 tasks) → Glob → TodoWrite(update)
  //   → TodoWrite(write-plan done) → ExitPlanMode
  //   → task_create → task_delegate → agent_spawn → TodoWrite(auto-clear)
  //   Uses Sonnet 4.6: Gemini drops function name tokens after 3+ sequential tool calls.
  //   task_create/task_delegate/agent_spawn all share taskToolsBoard — auto-wired.
  //   agent_spawn does NOT accept task_id (deferred to #1416); delegation is tracked
  //   separately on the board.
  {
    name: "interaction-full",
    prompt:
      "You are a coordinator. Execute ALL 11 steps below in order. Do not skip any step.\n" +
      "1. Call AskUserQuestion with ONE question: 'Which refactoring scope?' options: " +
      "'Targeted — one module only', 'Full — all modules'.\n" +
      "2. Call EnterPlanMode.\n" +
      "3. Call TodoWrite: [{id:'explore',content:'Explore repo',status:'in_progress'}, " +
      "{id:'write-plan',content:'Write plan',status:'pending'}, " +
      "{id:'dispatch',content:'Spawn refactor worker',status:'pending'}].\n" +
      "4. Call Glob pattern='*.json'.\n" +
      "5. Call TodoWrite: explore=completed, write-plan=in_progress, dispatch=pending.\n" +
      "6. Call TodoWrite: explore=completed, write-plan=completed, dispatch=in_progress.\n" +
      "7. Call ExitPlanMode.\n" +
      "8. Call task_create: subject='Refactor targeted module', description='Apply approved plan'. NOTE the returned task_id.\n" +
      "9. Call task_delegate: task_id=<from step 8>, agent_id='refactor-worker'. THIS STEP IS MANDATORY before agent_spawn.\n" +
      "10. Call agent_spawn: agent_name='refactor-worker', description='Refactor targeted module'.\n" +
      "11. Call TodoWrite: dispatch=completed (this clears the list).\n" +
      "Report: user choice, worker output, list cleared confirmation.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-interaction",
        cmd: ["echo", "interaction-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createInteractionProvider({
        elicit: async () => [{ selected: ["Targeted — one module only"] }],
      }),
      createBuiltinSearchProvider({ cwd: process.cwd() }),
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
    maxTurns: 14,
    modelAdapter: sonnetAdapter,
    modelName: SONNET_MODEL,
  },

  // ask-user: @koi/tools-builtin — AskUserQuestion with mock elicit
  //   LLM calls AskUserQuestion, elicit returns pre-canned answer, LLM reports result.
  {
    name: "ask-user",
    prompt:
      "Use AskUserQuestion to ask which refactoring approach to use: " +
      '"Extract Method" (pulls logic into a new function) or ' +
      '"Inline Method" (removes the function and inlines the code). ' +
      "Report which option was selected.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command",
        name: "on-ask-user",
        cmd: ["echo", "ask-user-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createInteractionProvider({
        // Pre-canned elicit: always selects first option (deterministic replay)
        elicit: async () => [{ selected: ["Extract Method"] }],
      }),
    ],
    maxTurns: 2,
  },

  // sandbox-exec: @koi/sandbox-os — Bash runs transparently inside OS sandbox (DI pattern).
  //   agent calls Bash tool → Bash routes through SandboxInstance.exec() → ATIF captures output.
  //   Sandbox adapter + restrictive profile are server-side config; model sees only Bash.
  //   Only included when platform detection succeeds (macOS seatbelt or Linux bwrap).
  ...(sandboxedBashProvider !== undefined
    ? [
        {
          name: "sandbox-exec",
          prompt:
            "Use the Bash tool to run `ls /usr/bin | wc -l` and tell me how many executables are in /usr/bin.",
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
          providers: [sandboxedBashProvider],
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

  // bash-track-cwd: @koi/tools-bash — trackCwd flag persists cwd across tool calls.
  //   Agent CDs into a subdir in one Bash call, then runs pwd in the next.
  //   Verifies that cwd state is maintained across calls (feature from #1521).
  //   workspaceRoot: process.cwd() avoids macOS /tmp→/private/tmp symlink issues.
  {
    name: "bash-track-cwd",
    prompt:
      "Use the Bash tool twice in sequence. " +
      'First call: run `mkdir -p packages/meta/runtime/.cwd-golden-test && cd packages/meta/runtime/.cwd-golden-test && echo "changed-dir"`. ' +
      "Second call: run `pwd` and report the directory printed.",
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [
      createSingleToolProvider({
        name: "bash",
        toolName: "Bash",
        createTool: () => createBashTool({ workspaceRoot: process.cwd(), trackCwd: true }),
      }),
    ],
    maxTurns: 3,
  },

  // bash-background: @koi/tools-bash — bash_background + task polling.
  //   Agent fires a background command, then polls task_get to check status,
  //   then reads output via task_output. Demonstrates fire-and-forget pattern.
  {
    name: "bash-background",
    prompt:
      "You MUST use the bash_background tool to run `echo 'hello-from-background'` in the background. " +
      "After it returns a taskId, use task_get with that taskId to check status. " +
      "Then use task_output with the same taskId to get the output. " +
      "Report what the stdout contained.",
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [
      bashBackgroundProvider,
      createSingleToolProvider({
        name: "task-get",
        toolName: "task_get",
        createTool: () => bgTtGet as import("@koi/core").Tool,
      }),
      createSingleToolProvider({
        name: "task-list",
        toolName: "task_list",
        createTool: () => bgTtList as import("@koi/core").Tool,
      }),
      createSingleToolProvider({
        name: "task-output",
        toolName: "task_output",
        createTool: () => bgTtOutput as import("@koi/core").Tool,
      }),
    ],
    maxTurns: 4,
  },

  // bash-ast-too-complex: @koi/bash-ast — proves the SYNC too-complex
  //   fallback path (no elicit wired). The command
  //   `export KOI_GREETING=hello; echo "$KOI_GREETING"` contains a
  //   `simple_expansion` inside a double-quoted string AND a standalone
  //   `variable_assignment`-style declaration, which the AST walker
  //   rejects as too-complex. Without an elicit callback wired, the sync
  //   classifier falls through to the regex TTP classifier, which finds
  //   no TTP match and allows the command. The subprocess then runs
  //   cleanly and prints "hello" — `export` puts the variable in the
  //   shell environment BEFORE the parameter expansion happens, which
  //   satisfies `set -u` (unlike a bare `KOI_GREETING=hello echo "$..."`
  //   inline prefix, where the expansion fires before the prefix takes
  //   effect on the builtin `echo`).
  //
  //   Covers the non-interactive code path used by `koi start`, standalone
  //   tool tests, and any caller without a prompt surface.
  //
  //   The interactive elicit path is covered by `bash-ast-elicit` below.
  {
    name: "bash-ast-too-complex",
    prompt:
      'Use the Bash tool to run this exact command and report the output: `export KOI_GREETING=hello; echo "$KOI_GREETING"`',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [
      createSingleToolProvider({
        name: "bash",
        toolName: "Bash",
        createTool: () => createBashTool({ workspaceRoot: process.cwd() }),
      }),
    ],
    maxTurns: 2,
  },

  // bash-ast-elicit: @koi/bash-ast — proves the INTERACTIVE elicit path.
  //   Same input shape as bash-ast-too-complex, but the bash tool is wired
  //   with an `elicit` callback that auto-approves. This exercises
  //   `classifyBashCommandWithElicit` end-to-end: too-complex → elicit →
  //   approve → regex TTP defense-in-depth → spawn → result.
  //
  //   End-to-end this proves: (1) the AST walker still routes $VAR-in-
  //   string to too-complex (nodeType is captured for the callback),
  //   (2) the elicit callback receives the correct command and reason,
  //   (3) the tool proceeds to spawn on approval, (4) the regex TTP
  //   classifier still runs as defense-in-depth after approval.
  //
  //   Closes #1634's full fail-closed loop: in production (TUI wiring)
  //   the user sees a permission dialog for too-complex commands instead
  //   of the silent regex fallback.
  {
    name: "bash-ast-elicit",
    prompt:
      'Use the Bash tool to run the command `export KOI_GREETING=world; echo "$KOI_GREETING"` and tell me the exact word that was printed.',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [
      createSingleToolProvider({
        name: "bash",
        toolName: "Bash",
        createTool: () =>
          createBashTool({
            workspaceRoot: process.cwd(),
            elicit: async () => true, // auto-approve for cassette recording
          }),
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

  // @koi/session — system-sender-resume: exercises privileged system:* sender persistence.
  // A prior session had an engine-injected system:doom-loop message (from doom loop detection).
  // The transcript stores it with role "system" + metadata.senderId = "system:doom-loop".
  // On resume, that entry must be replayed with senderId "system:doom-loop" (not downgraded
  // to "user"). Trajectory proves the system:* sender survives the persist/resume cycle.
  (() => {
    const crashedTranscript = [
      {
        id: transcriptEntryId("sysresume-e1"),
        role: "user" as const,
        content: "Use add_numbers to compute 5 + 5.",
        timestamp: Date.now() - 60000,
      },
      {
        id: transcriptEntryId("sysresume-e2"),
        role: "tool_call" as const,
        content: JSON.stringify([
          { id: "call-sr-01", toolName: "add_numbers", args: '{"a":5,"b":5}' },
        ]),
        timestamp: Date.now() - 59000,
      },
      {
        id: transcriptEntryId("sysresume-e3"),
        role: "tool_result" as const,
        content: '{"result":10}',
        timestamp: Date.now() - 58500,
      },
      {
        id: transcriptEntryId("sysresume-e4"),
        role: "assistant" as const,
        content: "The result of 5 + 5 is 10.",
        timestamp: Date.now() - 58000,
      },
      {
        id: transcriptEntryId("sysresume-e5"),
        role: "system" as const,
        content: "[System note]: Session checkpoint saved. You may continue with new tasks.",
        timestamp: Date.now() - 57000,
        metadata: { senderId: "system:doom-loop" },
      },
    ];

    const resumeResult = resumeFromTranscript(crashedTranscript);
    const resumeMessages = resumeResult.ok ? resumeResult.value.messages : [];

    // Verify the system:doom-loop sender survived resume
    const systemMsg = resumeMessages.find((m) => m.senderId === "system:doom-loop");
    if (systemMsg === undefined) {
      console.warn(
        "WARNING: system:doom-loop sender was NOT preserved through resume — " +
          "check session-transcript.ts and resume.ts",
      );
    } else {
      console.log(
        "System sender resume verified: system:doom-loop preserved through persist/resume cycle",
      );
    }

    const resumeTranscript = createInMemoryTranscript();
    return {
      name: "system-sender-resume",
      prompt:
        "You have the add_numbers tool available. " +
        "Use it to compute 20 + 30 and tell me the answer.",
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
          sessionId: sessionId("golden-system-sender-resume"),
        }),
      ],
    };
  })(),

  // skill-load: @koi/skills-runtime — loads skills from filesystem, attaches as SkillComponents
  //   createSkillProvider discovers the "bullet-points" skill from skillsTmpDir,
  //   attaches it under skillToken("bullet-points") in the agent ECS.
  //   Trajectory proves: skill provider wires into createKoi, attach succeeds, agent runs.
  {
    name: "skill-load",
    prompt: "What are the primary colors? Answer briefly.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [skillProvider],
  },

  // skill-tool-use: @koi/skill-tool — model invokes Skill meta-tool to load bullet-points
  //   createSkillTool uses the same skillRuntime as skill-load.
  //   Trajectory proves: Skill tool advertises skills, model invokes it, inline body returned.
  {
    name: "skill-tool-use",
    prompt:
      'Use the Skill tool to invoke the "bullet-points" skill. After invoking it, say "Skill loaded successfully."',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-skill-tool-exec",
        cmd: ["echo", "skill-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [skillToolProvider],
    maxTurns: 2,
  },

  // notebook-read: @koi/tool-notebook — reads a .ipynb fixture, returns cell summary
  {
    name: "notebook-read",
    prompt: `Use the notebook_read tool to read the notebook at "${NOTEBOOK_FIXTURE}" and report how many cells it has and their types.`,
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-notebook-read",
        cmd: ["echo", "notebook-read-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "notebook-read",
        toolName: "notebook_read",
        createTool: () => notebookReadTool,
      }),
    ],
    maxTurns: 2,
  },

  // notebook-add-cell: @koi/tool-notebook — adds a code cell, then reads back to confirm
  {
    name: "notebook-add-cell",
    prompt: `Use the notebook_add_cell tool to add a new code cell with source "print('added by golden query')" at index 1 in the notebook at "${notebookTmpPath}". Then use notebook_read to confirm the cell count increased to 4.`,
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-notebook-add",
        cmd: ["echo", "notebook-add-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "notebook-read",
        toolName: "notebook_read",
        createTool: () => notebookReadTool,
      }),
      createSingleToolProvider({
        name: "notebook-add-cell",
        toolName: "notebook_add_cell",
        createTool: () => notebookAddCellTool,
      }),
    ],
    maxTurns: 3,
  },

  // lsp-hover: @koi/lsp — LLM opens a document and gets hover info via mock LSP client
  {
    name: "lsp-hover",
    prompt:
      'First use the "lsp__golden-lsp__open_document" tool to open a document with uri "file:///src/main.ts" and content "function greet(name: string) { return name; }". ' +
      'Then use the "lsp__golden-lsp__hover" tool to get hover info at uri "file:///src/main.ts", line 0, character 9. ' +
      "Report the hover result.",
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-lsp-hover",
        cmd: ["echo", "lsp-hover-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [lspToolProvider],
    maxTurns: 3,
    modelAdapter: sonnetAdapter,
    modelName: SONNET_MODEL,
  },

  // browser-snapshot: @koi/tool-browser — LLM calls browser_snapshot via mock driver
  {
    name: "browser-snapshot",
    prompt:
      "Use the browser_snapshot tool to take a snapshot of the current page. Report what page elements you see.",
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-browser-snapshot",
        cmd: ["echo", "browser-snapshot-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [browserProvider],
    maxTurns: 2,
  },

  // skills-mcp-bridge: @koi/runtime bridge — MCP tools registered as skills
  {
    name: "skills-mcp-bridge",
    prompt: "What is 7 + 3? Reply with just the number.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [], // Set dynamically below (after MCP + bridge setup)
  },

  // MCP server: @koi/mcp-server exercised — platform tools exposed via MCP
  {
    name: "mcp-server-send",
    prompt:
      'Use the koi-platform__koi_send_message tool to send an event message to agent "target-agent" with type "status-update" and payload {"status": "ready"}. Report the result.',
    permissionMode: "bypass" as const,
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-mcp-server-tool",
        cmd: ["echo", "mcp-server-tool-done"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [], // Set dynamically below (after MCP server setup)
    maxTurns: 2,
  },

  // plugin-validate: exercises @koi/plugins manifest validation + registry discovery
  {
    name: "plugin-validate",
    prompt:
      'Use the validate_plugin tool to check this manifest: {"name": "hello-world", "version": "1.0.0", "description": "A greeting plugin"}. Report whether it is valid.',
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-plugin-validate",
        cmd: ["echo", "plugin-validated"],
        filter: { events: ["tool.succeeded"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "plugin-validator",
        toolName: "validate_plugin",
        createTool: () => {
          const result = buildTool({
            name: "validate_plugin",
            description:
              "Validates a plugin manifest JSON object against the @koi/plugins schema and discovers plugins from the registry.",
            inputSchema: {
              type: "object",
              properties: {
                manifest: {
                  type: "object",
                  description: "The plugin manifest to validate",
                },
              },
              required: ["manifest"],
            },
            origin: "primordial",
            execute: async (args: JsonObject) => {
              const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
              const { join } = await import("node:path");
              const { tmpdir } = await import("node:os");

              const validation = validatePluginManifest(args.manifest);

              // Create a real plugin root with a seeded plugin for non-trivial discovery
              const pluginRoot = await mkdtemp(join(tmpdir(), "koi-golden-plugins-"));
              const seededDir = join(pluginRoot, "seeded-plugin");
              await mkdir(seededDir, { recursive: true });
              await writeFile(
                join(seededDir, "plugin.json"),
                JSON.stringify({
                  name: "seeded-plugin",
                  version: "0.1.0",
                  description: "Golden test plugin",
                }),
              );

              const registry = createPluginRegistry({ bundledRoot: pluginRoot });
              const plugins = await registry.discover();
              const errors = registry.errors();

              // Cleanup temp dir
              await rm(pluginRoot, { recursive: true, force: true });

              return {
                valid: validation.ok,
                error: validation.ok ? undefined : validation.error.message,
                pluginName: validation.ok ? validation.value.name : undefined,
                discoveredCount: plugins.length,
                discoveredNames: plugins.map((p) => p.name),
                errorCount: errors.length,
              };
            },
          });
          if (!result.ok)
            throw new Error(`Failed to build validate_plugin tool: ${result.error.message}`);
          return result.value;
        },
      }),
    ],
    maxTurns: 2,
  },

  // plugin-lifecycle: exercises @koi/plugins install, list, enable/disable, remove
  {
    name: "plugin-lifecycle",
    prompt:
      "Use the plugin_lifecycle tool to install a plugin, list plugins, disable it, re-enable it, and remove it. Report each step's result.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [
      {
        kind: "command" as const,
        name: "on-plugin-lifecycle",
        cmd: ["echo", "lifecycle-step"],
        filter: { events: ["tool.succeeded"], tools: ["plugin_lifecycle"] },
      },
    ],
    providers: [
      createSingleToolProvider({
        name: "plugin-lifecycle",
        toolName: "plugin_lifecycle",
        createTool: () => {
          const result = buildTool({
            name: "plugin_lifecycle",
            description:
              "Runs a full plugin lifecycle: install → list → disable → enable → remove, exercising @koi/plugins lifecycle operations.",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
            origin: "primordial",
            execute: async () => {
              const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
              const { join } = await import("node:path");
              const { tmpdir } = await import("node:os");

              const tmpRoot = await mkdtemp(join(tmpdir(), "koi-golden-lifecycle-"));
              const userRoot = join(tmpRoot, "user-plugins");
              const sourceDir = join(tmpRoot, "source", "lifecycle-plugin");

              try {
                // Create source plugin
                await mkdir(sourceDir, { recursive: true });
                await writeFile(
                  join(sourceDir, "plugin.json"),
                  JSON.stringify({
                    name: "lifecycle-plugin",
                    version: "1.0.0",
                    description: "Golden lifecycle test plugin",
                  }),
                );

                const registry = createPluginRegistry({ userRoot });
                const config = { userRoot, registry };
                const steps: {
                  readonly step: string;
                  readonly ok: boolean;
                  readonly detail: string;
                }[] = [];

                // Install — verify API success AND returned metadata
                const installResult = await installPlugin(config, sourceDir);
                const installOk =
                  installResult.ok &&
                  installResult.value.name === "lifecycle-plugin" &&
                  installResult.value.version === "1.0.0";
                steps.push({
                  step: "install",
                  ok: installOk,
                  detail: installResult.ok
                    ? `${installResult.value.name}@${installResult.value.version}`
                    : installResult.error.message,
                });

                // List — verify exactly 1 plugin, enabled, correct name
                const listResult = await listPlugins(config);
                const listOk =
                  listResult.ok &&
                  listResult.value.entries.length === 1 &&
                  listResult.value.entries[0]?.meta.name === "lifecycle-plugin" &&
                  listResult.value.entries[0]?.enabled === true;
                steps.push({
                  step: "list",
                  ok: listOk,
                  detail: listResult.ok
                    ? `count=${String(listResult.value.entries.length)}, enabled=${String(listResult.value.entries[0]?.enabled)}`
                    : listResult.error.message,
                });

                // Disable — verify API success
                const disableResult = await disablePlugin(config, "lifecycle-plugin");
                steps.push({
                  step: "disable",
                  ok: disableResult.ok,
                  detail: disableResult.ok ? "disabled" : disableResult.error.message,
                });

                // List after disable — verify plugin shows as disabled
                const listAfterDisable = await listPlugins(config);
                const disableListOk =
                  listAfterDisable.ok &&
                  listAfterDisable.value.entries.length === 1 &&
                  listAfterDisable.value.entries[0]?.enabled === false;
                steps.push({
                  step: "list-after-disable",
                  ok: disableListOk,
                  detail: listAfterDisable.ok
                    ? `enabled=${String(listAfterDisable.value.entries[0]?.enabled)}`
                    : listAfterDisable.error.message,
                });

                // Enable — verify API success
                const enableResult = await enablePlugin(config, "lifecycle-plugin");
                steps.push({
                  step: "enable",
                  ok: enableResult.ok,
                  detail: enableResult.ok ? "enabled" : enableResult.error.message,
                });

                // Remove — verify API success
                const removeResult = await removePlugin(config, "lifecycle-plugin");
                steps.push({
                  step: "remove",
                  ok: removeResult.ok,
                  detail: removeResult.ok ? "removed" : removeResult.error.message,
                });

                // Final list — verify empty
                const finalList = await listPlugins(config);
                const finalListOk = finalList.ok && finalList.value.entries.length === 0;
                steps.push({
                  step: "list-after-remove",
                  ok: finalListOk,
                  detail: finalList.ok
                    ? `count=${String(finalList.value.entries.length)}`
                    : finalList.error.message,
                });

                return {
                  allPassed: steps.every((s) => s.ok),
                  stepCount: steps.length,
                  steps,
                };
              } finally {
                await rm(tmpRoot, { recursive: true, force: true });
              }
            },
          });
          if (!result.ok)
            throw new Error(`Failed to build plugin_lifecycle tool: ${result.error.message}`);
          return result.value;
        },
      }),
    ],
    maxTurns: 2,
  },

  // model-router: exercises @koi/model-router middleware — routing decision visible in trajectory.
  // extraMiddleware here mirrors the RuntimeConfig.modelRouterMiddleware opt-in path wired in
  // create-runtime.ts. The recording script uses its own assembler (not createRuntime), so
  // extraMiddleware is the equivalent injection point for cassette recording purposes.
  {
    name: "model-router",
    prompt: "What is 2+2? Answer with just the number.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [],
    extraMiddleware: [modelRouterMiddleware],
  },

  // @koi/middleware-audit + @koi/audit-sink-sqlite
  // Exercises the audit middleware end-to-end: session_start, model_call, session_end
  // events are captured by a capturing sink and written to audit-log.entries.json.
  // Trajectory proves the middleware fires without blocking the agent loop (fire-and-forget).
  ...(() => {
    // Capturing array shared between the sink closure and afterRecord callback.
    const capturedAuditEntries: AuditEntry[] = [];
    return [
      {
        name: "audit-log",
        prompt: "What is 2+2? Answer with just the number.",
        permissionMode: "bypass" as const,
        permissionRules: BYPASS_RULES,
        permissionDescription: "bypass (allow all)",
        hooks: [],
        providers: [],
        extraMiddleware: [
          createAuditMiddleware({
            sink: {
              log: async (entry: AuditEntry): Promise<void> => {
                capturedAuditEntries.push(entry);
              },
              flush: async (): Promise<void> => {},
            },
          }),
        ],
        afterRecord: async (fixtures: string, qName: string): Promise<void> => {
          await Bun.write(
            `${fixtures}/${qName}.entries.json`,
            JSON.stringify(
              { name: qName, capturedAt: Date.now(), entries: capturedAuditEntries },
              null,
              2,
            ),
          );
        },
      },
    ];
  })(),

  // --- @koi/loop convergence primitive (#1624) -------------------------------
  // Records a single agent turn for the loop primitive's replay golden.
  // Phase A intentionally uses a plain text prompt (no tool wiring) so
  // the cassette stays simple and the replay test validates the loop's
  // runtime integration, not tool execution. Real tool-driven loop
  // coverage (agent uses Bash to create a marker file, file gate checks
  // it, fail→retry→pass) is a follow-up when the loop package adds
  // first-class support for side-effect isolation between iterations.
  // Keeping this prompt in sync with the recordCassette call below so
  // the query config and the raw cassette cover the same scenario.
  {
    name: "loop-until-pass",
    prompt: "Respond with the single word: DONE",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all) for golden recording",
    hooks: [],
    providers: [],
    maxTurns: 2,
  },

  // @koi/outcome-evaluator — LLM-as-judge rubric iteration loop (#1686)
  // Agent explains recursion; grader evaluates two criteria (base case + self-call).
  // On first pass the grader should mark both satisfied; trajectory shows
  // evaluation.start → evaluation.end with result="satisfied" and criteria[].
  {
    name: "outcome-evaluator",
    prompt:
      "Write a two-sentence explanation of recursion. Make sure to mention the base case and how a function calls itself.",
    permissionMode: "bypass",
    permissionRules: BYPASS_RULES,
    permissionDescription: "bypass (allow all)",
    hooks: [],
    providers: [],
    maxTurns: 4,
    extraMiddleware: [
      createOutcomeEvaluatorMiddleware({
        rubric: {
          description: "Explain recursion clearly",
          criteria: [
            { name: "mentions_base_case", description: "Mentions a base case" },
            {
              name: "mentions_self_reference",
              description: "Mentions that a function calls itself",
            },
          ],
        },
        graderModelCall: async (prompt: string, signal?: AbortSignal): Promise<string> => {
          // Use the same model adapter as the agent for grading
          const response = await modelAdapter.complete({
            messages: [
              {
                senderId: "user",
                timestamp: Date.now(),
                content: [{ kind: "text", text: prompt }],
              },
            ],
            model: MODEL,
            signal,
          });
          return typeof response.content === "string" ? response.content : prompt;
        },
        maxIterations: 3,
      }).middleware,
    ],
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
await recordCassette("audit-log", () =>
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
            text: 'Use the task_create tool to create a task with subject "Review README" and description "Review the README for typos". Then use the task_list tool to show all tasks.',
          },
        ],
      },
    ],
    tools: taskBoardTools.map((t) => t.descriptor),
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

// Wire skills-mcp bridge: MCP resolver tools → skill registry via bridge
{
  const bridgeMcpServer = createTestMcpServer();
  const [bridgeClientSide, bridgeServerSide] = InMemoryTransport.createLinkedPair();
  await bridgeMcpServer.connect(bridgeServerSide);
  const bridgeConn = createMcpConnection(
    resolveServerConfig({ kind: "stdio", name: "bridge-mcp", command: "echo" }),
    undefined,
    {
      createClient: () => new McpSdkClient({ name: "bridge-client", version: "1.0.0" }) as never,
      createTransport: () => ({
        start: async () => {},
        close: async () => {
          await bridgeClientSide.close();
        },
        sdkTransport: bridgeClientSide,
        get sessionId() {
          return undefined;
        },
        onEvent: () => () => {},
      }),
    },
  );
  const bridgeResolver = createMcpResolver([bridgeConn]);
  const bridge = createSkillsMcpBridge({
    resolver: bridgeResolver,
    runtime: bridgeSkillRuntime,
  });
  await bridge.sync();
  // Verify MCP tools appeared as skills
  const bridgeDiscovered = await bridgeSkillRuntime.discover();
  if (bridgeDiscovered.ok) {
    const mcpSkills = [...bridgeDiscovered.value.values()].filter((s) => s.source === "mcp");
    console.log(
      `Skills-MCP bridge: ${mcpSkills.length} MCP tools registered as skills: [${mcpSkills.map((s) => s.name).join(", ")}]`,
    );
  }
  const bridgeProvider = createSkillProvider(bridgeSkillRuntime);
  const bridgeQuery = queries.find((q) => q.name === "skills-mcp-bridge");
  if (bridgeQuery !== undefined) {
    (bridgeQuery as { providers: ComponentProvider[] }).providers = [bridgeProvider];
  }
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

await recordCassette("todo-write", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text:
              "Use the TodoWrite tool to create a to-do list with two tasks: " +
              "first 'Write unit tests' with status 'in_progress', " +
              "and second 'Write documentation' with status 'pending'. " +
              "After calling the tool, report how many tasks are now in the list.",
          },
        ],
      },
    ],
    tools: [todoToolForCassette.descriptor],
  }),
);

await recordCassette("plan-mode", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text:
              "You are planning how to add a new feature to this repo. Follow these steps:\n" +
              "1. Call EnterPlanMode.\n" +
              "2. Call TodoWrite with two tasks: id='explore' content='Explore the repo structure' status='in_progress', " +
              "and id='write-plan' content='Write the implementation plan' status='pending'.\n" +
              "3. Call Glob with pattern='package.json' to explore the repo (this is the exploration work).\n" +
              "4. Call TodoWrite to mark 'explore' completed and 'write-plan' in_progress.\n" +
              "5. Call TodoWrite to mark 'write-plan' completed (auto-clear will fire).\n" +
              "6. Call ExitPlanMode.\n" +
              "Report what you found during exploration and confirm the plan was approved.",
          },
        ],
      },
    ],
    tools: [
      enterPlanModeToolForCassette.descriptor,
      todoToolForCassette.descriptor,
      exitPlanModeToolForCassette.descriptor,
      createGlobTool({ cwd: process.cwd() }).descriptor,
    ],
  }),
);

await recordCassette("ask-user", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text:
              "Use AskUserQuestion to ask which refactoring approach to use: " +
              '"Extract Method" (pulls logic into a new function) or ' +
              '"Inline Method" (removes the function and inlines the code). ' +
              "Report which option was selected.",
          },
        ],
      },
    ],
    tools: [askUserToolForCassette.descriptor],
  }),
);

await recordCassette(
  "interaction-full",
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
                "You are a coordinator. Execute ALL 11 steps below in order. Do not skip any step.\n" +
                "1. Call AskUserQuestion with ONE question: 'Which refactoring scope?' options: " +
                "'Targeted — one module only', 'Full — all modules'.\n" +
                "2. Call EnterPlanMode.\n" +
                "3. Call TodoWrite: [{id:'explore',content:'Explore repo',status:'in_progress'}, " +
                "{id:'write-plan',content:'Write plan',status:'pending'}, " +
                "{id:'dispatch',content:'Spawn refactor worker',status:'pending'}].\n" +
                "4. Call Glob pattern='*.json'.\n" +
                "5. Call TodoWrite: explore=completed, write-plan=in_progress, dispatch=pending.\n" +
                "6. Call TodoWrite: explore=completed, write-plan=completed, dispatch=in_progress.\n" +
                "7. Call ExitPlanMode.\n" +
                "8. Call task_create: subject='Refactor targeted module', description='Apply approved plan'. NOTE the returned task_id.\n" +
                "9. Call task_delegate: task_id=<from step 8>, agent_id='refactor-worker'. THIS STEP IS MANDATORY before agent_spawn.\n" +
                "10. Call agent_spawn: agent_name='refactor-worker', description='Refactor targeted module', task_id=<from step 8>.\n" +
                "11. Call TodoWrite: dispatch=completed (this clears the list).\n" +
                "Report: user choice, worker output, list cleared confirmation.",
            },
          ],
        },
      ],
      tools: [
        askUserToolForCassette.descriptor,
        enterPlanModeToolForCassette.descriptor,
        todoToolForCassette.descriptor,
        exitPlanModeToolForCassette.descriptor,
        createGlobTool({ cwd: process.cwd() }).descriptor,
        ttCreate.descriptor,
        ttDelegate.descriptor,
        stAgentSpawn.descriptor,
      ],
    }),
  { model: SONNET_MODEL },
);

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

// skill-load: @koi/skills-runtime — no tools, text-only response
await recordCassette("skill-load", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "What are the primary colors? Answer briefly." }],
      },
    ],
  }),
);

// skill-tool-use: @koi/skill-tool — model calls Skill tool to load bullet-points
await recordCassette("skill-tool-use", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: 'Use the Skill tool to invoke the "bullet-points" skill. After invoking it, say "Skill loaded successfully."',
          },
        ],
      },
    ],
    tools: [skillTool.descriptor],
  }),
);

// skills-mcp-bridge: text-only response (bridge registers MCP tools as skills)
await recordCassette("skills-mcp-bridge", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "What is 7 + 3? Reply with just the number." }],
      },
    ],
  }),
);

await recordCassette("exfiltration-guard-block", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: `Use the send_message tool with message set to exactly this string: ${btoa("AKIAIOSFODNN7EXAMPLE")}. Do not modify or decode it, just pass it as-is.`,
          },
        ],
      },
    ],
    tools: [sendMessageTool.descriptor],
  }),
);

await recordCassette("notebook-read", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: `Use the notebook_read tool to read the notebook at "${NOTEBOOK_FIXTURE}" and report how many cells it has and their types.`,
          },
        ],
      },
    ],
    tools: [notebookReadTool.descriptor],
  }),
);

await recordCassette("notebook-add-cell", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: `Use the notebook_add_cell tool to add a new code cell with source "print('added by golden query')" at index 1 in the notebook at "${notebookTmpPath}". Then use notebook_read to confirm the cell count increased to 4.`,
          },
        ],
      },
    ],
    tools: [notebookReadTool.descriptor, notebookAddCellTool.descriptor],
  }),
);

// lsp-hover uses Sonnet 4.6 — Gemini 2.0 Flash returns 400 on tool names with '/' separators
await recordCassette(
  "lsp-hover",
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
                'First use the "lsp__golden-lsp__open_document" tool to open a document with uri "file:///src/main.ts" and content "function greet(name: string) { return name; }". ' +
                'Then use the "lsp__golden-lsp__hover" tool to get hover info at uri "file:///src/main.ts", line 0, character 9. ' +
                "Report the hover result.",
            },
          ],
        },
      ],
      tools: lspTools.map((t) => t.descriptor),
    }),
  { model: SONNET_MODEL },
);

await recordCassette("browser-snapshot", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: "Use the browser_snapshot tool to take a snapshot of the current page. Report what page elements you see.",
          },
        ],
      },
    ],
    tools: [browserSnapshotForCassette.descriptor],
  }),
);

import type { AttachResult, Tool } from "@koi/core";
// ---------------------------------------------------------------------------
// MCP server setup: @koi/mcp-server platform tools via InMemoryTransport
// ---------------------------------------------------------------------------
import { agentId, toolToken } from "@koi/core";

const mcpServerSentMessages: unknown[] = [];
const mcpServerMailbox = {
  send: async (input: unknown) => {
    mcpServerSentMessages.push(input);
    return {
      ok: true as const,
      value: {
        ...(input as Record<string, unknown>),
        id: `msg-${mcpServerSentMessages.length}`,
        createdAt: new Date().toISOString(),
      },
    };
  },
  onMessage: () => () => {},
  list: async () => [],
};

const [mcpServerClientTransport, mcpServerServerTransport] = InMemoryTransport.createLinkedPair();

const mcpPlatformAgent = {
  manifest: { name: "golden-mcp-server", version: "0.0.0", description: "golden" },
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
};

const mcpPlatformServer = createMcpServer({
  agent: mcpPlatformAgent as never,
  transport: mcpServerServerTransport,
  name: "koi-platform",
  platform: {
    callerId: agentId("golden-caller"),
    mailbox: mcpServerMailbox as never,
  },
});
await mcpPlatformServer.start();

// Connect MCP SDK Client directly to the server
const mcpServerClient = new McpSdkClient({ name: "golden-client", version: "1.0.0" });
await mcpServerClient.connect(mcpServerClientTransport);

// Discover tools and wrap them as a ComponentProvider
const mcpServerToolList = await mcpServerClient.listTools();
const mcpServerComponentProvider: ComponentProvider = {
  name: "mcp-server-platform",
  async attach(): Promise<AttachResult> {
    const components = new Map<string, unknown>();
    for (const t of mcpServerToolList.tools) {
      const namespacedName = `koi-platform__${t.name}`;
      const tool: Tool = {
        descriptor: {
          name: namespacedName,
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? {}) as JsonObject,
          origin: "operator",
          server: "koi-platform",
        },
        origin: "operator",
        policy: { sandbox: false, capabilities: {} },
        execute: async (args: JsonObject) => {
          const result = await mcpServerClient.callTool({
            name: t.name,
            arguments: args as Record<string, unknown>,
          });
          const content = result.content as readonly { type: string; text: string }[];
          return content[0]?.text ?? "";
        },
      };
      components.set(toolToken(namespacedName), tool);
    }
    return { components, skipped: [] };
  },
};

// Inject MCP server provider for the mcp-server-send query
const mcpServerQuery = queries.find((q) => q.name === "mcp-server-send");
if (mcpServerQuery !== undefined) {
  (mcpServerQuery as { providers: ComponentProvider[] }).providers = [mcpServerComponentProvider];
}

// --- @koi/loop convergence primitive (#1624) -------------------------------
// Record a cassette the loop-replay golden test can consume. This captures
// the raw model stream for a simple "create a marker file then respond
// DONE" prompt; the golden replay test wires a Bash tool + runUntilPass
// around it and asserts the loop drives the runtime correctly.
await recordCassette("loop-until-pass", () =>
  modelAdapter.stream({
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [
          {
            kind: "text",
            text: "Respond with the single word: DONE",
          },
        ],
      },
    ],
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

// Cleanup MCP servers + nexus transport
await mcpSetup.cleanup();
await mcpServerClient.close();
await mcpPlatformServer.stop();
nexusTransport?.close();

console.log(`\nDone. ${12 + queries.length} fixture files ready:`);
console.log("  fixtures/simple-text.cassette.json");
console.log("  fixtures/tool-use.cassette.json");
console.log("  fixtures/task-tools.cassette.json");
console.log("  fixtures/spawn-tools.cassette.json");
console.log("  fixtures/hook-redaction.cassette.json");
console.log("  fixtures/todo-write.cassette.json");
console.log("  fixtures/plan-mode.cassette.json");
console.log("  fixtures/ask-user.cassette.json");
console.log("  fixtures/interaction-full.cassette.json");
console.log("  fixtures/mcp-tool-use.cassette.json");
console.log("  fixtures/notebook-read.cassette.json");
console.log("  fixtures/notebook-add-cell.cassette.json");
console.log("  fixtures/lsp-hover.cassette.json");
console.log("  fixtures/browser-snapshot.cassette.json");
for (const q of queries) {
  console.log(`  fixtures/${q.name}.trajectory.json`);
}
