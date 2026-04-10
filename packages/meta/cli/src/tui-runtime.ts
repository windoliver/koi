/**
 * TUI runtime factory — assembles the full L2 tool stack for `koi tui`.
 *
 * Wires:
 *   @koi/event-trace          — in-memory trajectory recording (for /trajectory view)
 *   @koi/hooks                — command hook dispatch
 *   @koi/permissions          — permission backend (default mode)
 *   @koi/middleware-permissions — permission gating middleware
 *   @koi/tools-builtin        — Glob, Grep, ToolSearch providers
 *   @koi/fs-local             — local filesystem backend
 *   @koi/sandbox-os           — OS sandbox adapter (auto-applied to Bash via DI)
 *   @koi/tools-bash           — Bash execution (sandboxed when adapter available) + bash_background
 *   @koi/tasks                — in-memory task board for background job tracking
 *   @koi/task-tools           — task_create, task_get, task_update, task_list, task_stop, task_output
 *   @koi/tools-web            — web_fetch
 *   @koi/tool-notebook        — notebook_read, notebook_add_cell, notebook_replace_cell, notebook_delete_cell
 *   @koi/session              — JSONL transcript recording (optional, via config.session)
 *   @koi/engine               — system prompt middleware (optional, via config.systemPrompt)
 *   @koi/middleware-goal       — adaptive goal reminders (optional, via config.goals)
 *   @koi/skills-runtime        — three-tier skill discovery (bundled → user → project)
 *   @koi/skill-tool            — on-demand skill loading meta-tool (Skill)
 *
 * MCP wired: loads .mcp.json, creates resolver + provider, bridges MCP tools → skills.
 * Hook loading from user config is deferred — currently passes empty hooks.
 *
 * Returns the KoiRuntime, the mutable transcript array (for session resets),
 * and a getTrajectorySteps() accessor for the /trajectory TUI command.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalHandler,
  InboundMessage,
  ManagedTaskBoard,
  MemoryRecord,
  MemoryRecordInput,
  ModelAdapter,
  RichTrajectoryStep,
  SessionId,
  SessionTranscript,
  SpawnFn,
} from "@koi/core";
import {
  createSingleToolProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  agentId as makeAgentId,
  memoryRecordId,
} from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import { createKoi, createSystemPromptMiddleware } from "@koi/engine";
import { createEventTraceMiddleware, createInMemoryAtifDocumentStore } from "@koi/event-trace";
import { createLocalFileSystem } from "@koi/fs-local";
import type { PromptModelCaller } from "@koi/hook-prompt";
import { createHookMiddleware, createRegisteredHooks, loadRegisteredHooks } from "@koi/hooks";
import type { McpResolver } from "@koi/mcp";
import { createMcpComponentProvider, createMcpResolver, loadMcpJsonFile } from "@koi/mcp";
import type { MemoryToolBackend } from "@koi/memory-tools";
import { createMemoryToolProvider } from "@koi/memory-tools";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import { createExtractionMiddleware } from "@koi/middleware-extraction";
import { createGoalMiddleware } from "@koi/middleware-goal";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import {
  createRetrySignalBroker,
  createSemanticRetryMiddleware,
} from "@koi/middleware-semantic-retry";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { createRulesMiddleware } from "@koi/rules-loader";
import type { SkillsMcpBridge } from "@koi/runtime";
import { createHookObserver, createSkillsMcpBridge, wrapMiddlewareWithTrace } from "@koi/runtime";
import { createOsAdapter, mergeProfile, restrictiveProfile } from "@koi/sandbox-os";
import { createSessionTranscriptMiddleware } from "@koi/session";
import { createSkillTool } from "@koi/skill-tool";
import type { SkillsRuntime } from "@koi/skills-runtime";
import { createSpawnTools } from "@koi/spawn-tools";
import { createTaskTools } from "@koi/task-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import {
  createNotebookAddCellTool,
  createNotebookDeleteCellTool,
  createNotebookReadTool,
  createNotebookReplaceCellTool,
} from "@koi/tool-notebook";
import { createBashBackgroundTool, createBashToolWithHooks } from "@koi/tools-bash";
import {
  createBuiltinSearchProvider,
  createFsEditTool,
  createFsReadTool,
  createFsWriteTool,
} from "@koi/tools-builtin";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { createTranscriptAdapter } from "./engine-adapter.js";
import { createOAuthAwareMcpConnection } from "./mcp-connection-factory.js";
import { loadPluginComponents } from "./plugin-activation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum trajectory steps retained in the in-memory store for /trajectory view. */
export const MAX_TRAJECTORY_STEPS = 200;

/** Document ID used for TUI session trajectory storage. */
const TUI_DOC_ID = "koi-tui-session";

/** Maximum model→tool→model turns per user submit in the TUI. */
const DEFAULT_MAX_TURNS = 10;

/** Maximum messages retained in the transcript context window.
 * Matches the default for `koi start --context-window` (100).
 * A lower cap (e.g. 20) causes the model to silently lose context
 * after ~10 exchanges with no compaction to preserve it. */
const MAX_TRANSCRIPT_MESSAGES = 100;

/**
 * Temp directory for task result storage. Enables `task_update(status="completed")`
 * by making `hasResultPersistence()` return true. Results survive the session but
 * not reboots — acceptable for interactive TUI sessions.
 */
const TASK_RESULTS_DIR = join(tmpdir(), "koi-tui-task-results");

// ---------------------------------------------------------------------------
// In-memory memory backend (same pattern as record-cassettes.ts)
// ---------------------------------------------------------------------------

/** In-memory MemoryToolBackend with session-scoped clear(). */
interface ClearableMemoryBackend extends MemoryToolBackend {
  /** Clear all stored memories — called on session reset. */
  readonly clear: () => void;
}

function createInMemoryMemoryBackend(): ClearableMemoryBackend {
  const records = new Map<string, MemoryRecord>();
  // let: mutable counter for ID generation
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
    clear: () => {
      records.clear();
      counter = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Config & return types
// ---------------------------------------------------------------------------

export interface TuiRuntimeConfig {
  /** Model HTTP adapter — its complete/stream terminals are exposed to middleware. */
  readonly modelAdapter: ModelAdapter;
  /** Model name for ATIF metadata. */
  readonly modelName: string;
  /** Approval handler for permission prompts — should be permissionBridge.handler. */
  readonly approvalHandler: ApprovalHandler;
  /** Working directory for file tools (Glob, fs_read, Bash). Defaults to process.cwd(). */
  readonly cwd?: string | undefined;
  /**
   * System prompt injected via createSystemPromptMiddleware.
   * Tells the model it has tools and should use them.
   * When omitted, no system prompt middleware is installed.
   */
  readonly systemPrompt?: string | undefined;
  /**
   * Goal objectives for the middleware-goal adaptive reminder system.
   * When provided, createGoalMiddleware is installed in the middleware stack
   * to inject goal reminders and detect drift/completion.
   * When omitted, no goal middleware is installed.
   */
  readonly goals?: readonly string[] | undefined;
  /**
   * Session transcript config for JSONL recording + session resume.
   * When omitted, no session transcript middleware is installed.
   */
  readonly session?:
    | {
        readonly transcript: SessionTranscript;
        readonly sessionId: SessionId;
      }
    | undefined;
  /**
   * Optional SkillsRuntime for MCP bridge integration.
   * When provided and .mcp.json exists, MCP tools are registered as skills
   * via createSkillsMcpBridge.
   */
  readonly skillsRuntime?: SkillsRuntime | undefined;
}

export interface TuiRuntimeHandle {
  /** The assembled KoiRuntime — call runtime.run(input) to stream a turn. */
  readonly runtime: KoiRuntime;
  /**
   * Mutable conversation transcript array — owned by the caller.
   * Splice to reset: `transcript.splice(0)` on agent:clear or session:new.
   */
  readonly transcript: InboundMessage[];
  /**
   * Retrieve the current session's ATIF trajectory steps (last MAX_TRAJECTORY_STEPS).
   *
   * Data source: in-memory event-trace store — no disk I/O.
   * Used by the /trajectory TUI command.
   */
  readonly getTrajectorySteps: () => Promise<readonly RichTrajectoryStep[]>;
  /**
   * Reset stateful tool state for a new session (agent:clear / session:new).
   *
   * @param signal — the active run's AbortSignal. Must already be aborted
   * (`signal.aborted === true`). Enforced at runtime — throws if the caller
   * forgot to abort the controller before resetting session state.
   *
   * Aborting first ensures all in-flight tool calls are cancelled before
   * the board pointer moves, closing the window where a tool call could observe
   * the old board via `add`/`assign` and then the new board via `complete`/`fail`.
   *
   * 1. Resets the Bash tool's tracked cwd to workspace root.
   * 2. Aborts prior-session background subprocesses (SIGTERM → SIGKILL) and
   *    rotates the AbortController so new tasks use a fresh signal.
   * 3. Rotates the task board to a fresh in-memory instance — prior-session tasks
   *    are abandoned with the old board and not discoverable via task_list /
   *    task_get / task_output in the new session.
   * 4. Clears session-scoped approval state (always-allow, approval cache, denial
   *    trackers) so prior-session approvals do not silently carry into the new session.
   * 5. Clears the in-memory trajectory store for the new session.
   */
  readonly resetSessionState: (signal: AbortSignal) => Promise<void>;
  /**
   * Abort all in-flight bash_background subprocesses (SIGTERM → SIGKILL).
   *
   * Call before `runtime.dispose()` on shutdown (SIGINT/SIGTERM/system:quit) so
   * background commands don't outlive the process as orphaned OS subprocesses.
   *
   * If this returns `true` (tasks were in-flight), wait at least
   * `SIGKILL_ESCALATION_MS + 200` ms before calling `process.exit()` to allow
   * the SIGTERM → SIGKILL escalation timers to fire. Exiting before SIGKILL
   * cancels those timers, leaving subprocesses that ignore SIGTERM as orphans.
   */
  readonly shutdownBackgroundTasks: () => boolean;
  /**
   * Returns true if any background subprocesses are currently in-flight.
   *
   * Uses the authoritative live-subprocess counter from `onSubprocessStart`/
   * `onSubprocessEnd` callbacks — not task-board state, which can diverge
   * when `task_stop` changes board state without terminating the OS process.
   *
   * Check immediately before `shutdownBackgroundTasks()` to determine whether
   * to wait for the SIGKILL escalation window before `process.exit()`.
   */
  readonly hasActiveBackgroundTasks: () => boolean;
  /**
   * True if the OS sandbox adapter (seatbelt / bwrap) was successfully initialised.
   *
   * When false, Bash and bash_background run without OS-level filesystem confinement —
   * only the @koi/bash-security denylist guard applies. Surface a warning to the user
   * in the TUI so they are aware of the reduced isolation posture.
   */
  readonly sandboxActive: boolean;
}

// ---------------------------------------------------------------------------
// MCP loading (optional, from .mcp.json)
// ---------------------------------------------------------------------------

interface McpSetup {
  readonly resolver: McpResolver;
  readonly provider: import("@koi/core").ComponentProvider;
  readonly bridge: SkillsMcpBridge | undefined;
  readonly dispose: () => void;
}

async function loadMcp(
  cwd: string,
  skillsRuntime: SkillsRuntime | undefined,
): Promise<McpSetup | undefined> {
  const mcpConfigPath = join(cwd, ".mcp.json");
  const result = await loadMcpJsonFile(mcpConfigPath);
  if (!result.ok) return undefined;
  if (result.value.servers.length === 0) return undefined;

  const connections = result.value.servers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });

  // Wire bridge if skillsRuntime provided
  let bridge: SkillsMcpBridge | undefined;
  if (skillsRuntime !== undefined) {
    bridge = createSkillsMcpBridge({ resolver, runtime: skillsRuntime });
    try {
      await bridge.sync();
    } catch {
      // Non-fatal — MCP tools just won't appear as skills
      bridge = undefined;
    }
  }

  return {
    resolver,
    provider,
    bridge,
    dispose: () => {
      bridge?.dispose();
      resolver.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Assemble the full L2 tool stack for `koi tui` via createKoi.
 *
 * Blueprint: record-cassettes.ts — this is the same composition used in
 * golden query recording, simplified to the TUI's surface (no ATIF file writes,
 * no hook agent executor). MCP loaded from .mcp.json when present.
 */
export async function createTuiRuntime(config: TuiRuntimeConfig): Promise<TuiRuntimeHandle> {
  const { modelAdapter, modelName, approvalHandler, cwd = process.cwd(), skillsRuntime } = config;

  // --- MCP setup (optional, from .mcp.json) ---
  const mcpSetup = await loadMcp(cwd, skillsRuntime);

  // --- Plugin activation: load enabled plugins' hooks, MCP, skills ---
  const pluginUserRoot = join(homedir(), ".koi", "plugins");
  const pluginComponents = await loadPluginComponents(pluginUserRoot);
  if (pluginComponents.errors.length > 0) {
    for (const err of pluginComponents.errors) {
      console.warn(`[koi tui] plugin "${err.plugin}": ${err.error}`);
    }
  }
  if (pluginComponents.middlewareNames.length > 0) {
    console.warn(
      `[koi tui] ${String(pluginComponents.middlewareNames.length)} plugin middleware name(s) skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
    );
  }

  // Register plugin skills with the SkillsRuntime (if any)
  if (skillsRuntime !== undefined && pluginComponents.skillMetadata.length > 0) {
    skillsRuntime.registerExternal(pluginComponents.skillMetadata);
  }

  // Create additional MCP connections from plugins
  let pluginMcpSetup: McpSetup | undefined;
  if (pluginComponents.mcpServers.length > 0) {
    const connections = pluginComponents.mcpServers.map((server) =>
      createOAuthAwareMcpConnection(server),
    );
    const resolver = createMcpResolver(connections);
    const provider = createMcpComponentProvider({ resolver });
    pluginMcpSetup = {
      resolver,
      provider,
      bridge: undefined,
      dispose: () => {
        resolver.dispose();
      },
    };
  }

  // Session generation counter — incremented on each reset.
  // The trace wrapper and event-trace MW capture the doc ID at construction
  // and can't be rotated after createKoi assembly. The prune is awaited to
  // minimize the window, but late fire-and-forget appends from the old
  // session's trace can theoretically recreate the pruned document.
  // In practice this window is <1ms (prune completes before new submit).
  // Full fix requires doc-ID rotation which needs API changes to the trace
  // wrapper — tracked as a known limitation.

  // --- Trajectory store (in-memory ATIF store — production-grade with mutex + eviction) ---
  // Cap at MAX_TRAJECTORY_STEPS to match the /trajectory view cap — no point storing
  // steps the user can never see. Using the event-trace store gains atomic step IDs,
  // per-doc mutex, size enforcement, and idempotent appends for free.
  const trajectoryStore = createInMemoryAtifDocumentStore({
    agentName: "koi-tui",
    agentVersion: "0.1.0",
    maxSteps: MAX_TRAJECTORY_STEPS,
  });

  // --- @koi/middleware-semantic-retry: retry signal broker ---
  // Created before event-trace so it can be wired as signalReader.
  const retryBroker = createRetrySignalBroker();

  // --- @koi/event-trace: record model/tool I/O for /trajectory view ---
  const { middleware: eventTraceMw } = createEventTraceMiddleware({
    store: trajectoryStore,
    docId: TUI_DOC_ID,
    agentName: "koi-tui",
    agentVersion: "0.1.0",
    signalReader: retryBroker,
  });
  const { middleware: semanticRetryMw } = createSemanticRetryMiddleware({
    signalWriter: retryBroker,
  });

  // --- Hook observer: records hook execution as ATIF trajectory steps ---
  // Pure observer — subscribes to hook registry's onExecuted tap, does not dispatch.
  // Same pattern as golden-query recording (record-cassettes.ts).
  const { onExecuted: hookObserverTap, middleware: hookObserverMw } = createHookObserver({
    store: trajectoryStore,
    docId: TUI_DOC_ID,
  });

  // --- @koi/hooks: load hooks from ~/.koi/hooks.json + command hook dispatch ---
  // Same pattern as koi start: load user hooks, wire observer tap for ATIF recording.
  // Absent/unreadable file = no hooks (empty array, middleware is a no-op).
  // Agent hooks (kind: "agent") are filtered out because the TUI does not provide
  // a spawnFn — createHookMiddleware throws if any agent hook is present without one.
  // Prompt hooks (kind: "prompt") are supported via a lightweight PromptModelCaller
  // that delegates to the TUI's model adapter for single-shot verification.
  const hooksConfigPath = join(homedir(), ".koi", "hooks.json");
  // let: justified — set after async load
  let loadedHooks: readonly import("@koi/hooks").RegisteredHook[] = [];
  try {
    const raw: unknown = await Bun.file(hooksConfigPath).json();
    const hookResult = loadRegisteredHooks(raw, "user");
    if (hookResult.ok) {
      const agentHooks = hookResult.value.filter((rh) => rh.hook.kind === "agent");
      if (agentHooks.length > 0) {
        console.warn(
          `[koi tui] ${agentHooks.length} agent hook(s) skipped (not supported in TUI): ` +
            agentHooks.map((rh) => rh.hook.name).join(", "),
        );
      }
      loadedHooks = hookResult.value.filter((rh) => rh.hook.kind !== "agent");
    }
  } catch {
    // Absent or unreadable — silently skip (no hooks configured)
  }

  // Merge plugin hooks (session tier) with user hooks (user tier).
  // Plugin hooks run first within their tier; user hooks in the next tier phase.
  const pluginRegistered = createRegisteredHooks(
    pluginComponents.hooks.filter((h) => h.kind !== "agent"),
    "session",
  );
  const allHooks: readonly import("@koi/hooks").RegisteredHook[] = [
    ...loadedHooks,
    ...pluginRegistered,
  ];

  // Lightweight PromptModelCaller — delegates to the TUI's model adapter for
  // single-shot LLM verification. Builds a minimal ModelRequest with the
  // verification prompt as a user message and the system prompt in the
  // trusted systemPrompt field.
  const promptCallFn: PromptModelCaller = {
    complete: async (req) => {
      const userMessage: InboundMessage = {
        content: [{ kind: "text", text: req.userPrompt }],
        senderId: "hook-prompt",
        timestamp: Date.now(),
      };
      const response = await modelAdapter.complete({
        messages: [userMessage],
        model: req.model,
        maxTokens: req.maxTokens,
        systemPrompt: req.systemPrompt,
        signal: AbortSignal.timeout(req.timeoutMs),
        tools: [], // No tools for single-shot verification
      });
      return { text: response.content };
    },
  };

  const hasPromptHooks = allHooks.some((rh) => rh.hook.kind === "prompt");
  const hookMw = createHookMiddleware({
    hooks: allHooks,
    promptCallFn: hasPromptHooks ? promptCallFn : undefined,
    onExecuted: hookObserverTap,
  });

  // --- @koi/permissions + @koi/middleware-permissions ---
  // Default mode: read-only tools are pre-allowed; shell/network/write tools
  // require user approval. Unmatched tools fall through to "ask" (mode default).
  //
  // Allowlist reasoning:
  //   Glob, Grep, ToolSearch — filesystem search, no mutations
  //   fs_read                — read-only file access
  //   task_*                 — task board reads/writes (own state, not workspace)
  //
  // Bash, bash_background, web_fetch, fs_write, fs_edit are intentionally not listed
  // so they fall to "ask" — the mode-default fallback for unmatched tools.
  const tuiAllowRules: readonly SourcedRule[] = [
    { pattern: "Glob", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "Grep", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "ToolSearch", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "fs_read", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_get", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_list", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_output", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_create", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_update", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_stop", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "Skill", action: "invoke", effect: "allow", source: "policy" },
  ] as const;
  const permBackend = createPermissionBackend({
    mode: "default",
    rules: tuiAllowRules,
  });
  const permMw = createPermissionsMiddleware({
    backend: permBackend,
    description: "koi tui — default permission mode",
  });

  // --- @koi/fs-local: local filesystem backend ---
  const localFs = createLocalFileSystem(cwd);

  // --- @koi/tools-builtin: Glob, Grep, ToolSearch search provider ---
  // Also provides fs_read, fs_write, fs_edit via individual providers below.
  const builtinSearchProvider = createBuiltinSearchProvider({ cwd });

  // Filesystem read/write/edit tools backed by the local filesystem backend.
  // Each tool is wrapped in a single-tool provider for createKoi assembly.
  const fsReadProvider = createSingleToolProvider({
    name: "fs-read",
    toolName: "fs_read",
    createTool: () => createFsReadTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
  });
  const fsWriteProvider = createSingleToolProvider({
    name: "fs-write",
    toolName: "fs_write",
    createTool: () => createFsWriteTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
  });
  const fsEditProvider = createSingleToolProvider({
    name: "fs-edit",
    toolName: "fs_edit",
    createTool: () => createFsEditTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
  });

  // --- @koi/sandbox-os: OS sandbox adapter (injected into Bash, not a separate tool) ---
  // When available (macOS seatbelt / Linux bubblewrap), all Bash commands run
  // inside the OS sandbox automatically — no separate model-visible tool.
  // Degrades gracefully: if the platform binary is unavailable, Bash falls back
  // to the unsandboxed path with the @koi/bash-security denylist guard.
  //
  // Profile: restrictive base (credential paths denied) + network + write paths.
  // The TUI is a developer tool — builds, installs, and file edits must be able
  // to write to the workspace and standard temp/cache locations.
  // Without allowWrite entries the sandbox would deny all file-write* operations,
  // silently breaking `bun install`, artifact-emitting builds, and shell commands
  // that create files.
  const osSandboxResult = createOsAdapter();
  const sandboxAdapter = osSandboxResult.ok ? osSandboxResult.value : undefined;
  const sandboxProfile = osSandboxResult.ok
    ? mergeProfile(restrictiveProfile(), {
        network: { allow: true },
        filesystem: {
          allowWrite: [
            cwd, // workspace root — builds, installs, file edits
            "/tmp", // POSIX temp (seatbelt canonicalizes /tmp → /private/tmp on macOS)
            "/var/folders", // macOS user cache area (Bun install temp, compiler cache)
          ],
        },
      })
    : undefined;

  // --- Background task abort controller (mutable — rotated on session reset) ---
  // Using `let` so resetSessionState() can abort the old controller (killing
  // prior-session subprocesses) and create a fresh one for the next session.
  // bash_background reads this via getSignal() at launch time, not at construction,
  // so it always uses the current session's controller.
  // eslint-disable-next-line prefer-const
  let bgController = new AbortController();

  // --- Live subprocess counter (authoritative count of in-flight runBackground goroutines) ---
  // Incremented just before each subprocess launch via onSubprocessStart, decremented on exit.
  // Task-board status is not a reliable proxy: task_stop can move a task to "killed" state
  // while the OS subprocess is still running. This counter is used by hasActiveBackgroundTasks()
  // to decide whether to wait for the SIGKILL escalation window on shutdown.
  // let justified: mutable, incremented/decremented from async fire-and-forget completions.
  let liveSubprocessCount = 0;

  // --- @koi/tasks: in-memory task board for background bash job tracking ---
  // Memory store only — background task results survive the session but not
  // process restarts (acceptable for TUI interactive sessions).
  //
  // boardRef holds the active board instance; replaced on each session reset to
  // isolate prior-session task output from the new session. The proxy below
  // delegates all calls to boardRef.current, so the cached tool providers
  // transparently switch boards without requiring provider recreation.
  const boardRef: { current: ManagedTaskBoard } = {
    current: await createManagedTaskBoard({
      store: createMemoryTaskBoardStore(),
      resultsDir: TASK_RESULTS_DIR,
    }),
  };

  // Proxy transparently delegates all ManagedTaskBoard property access to
  // boardRef.current. Replacing boardRef.current on session reset makes prior
  // tasks invisible to the new session's task_list / task_get / task_output calls.
  // Unlike a manual delegation object, this auto-forwards new interface methods
  // without code changes.
  const taskBoard = new Proxy({} as ManagedTaskBoard, {
    get(_target, prop, receiver) {
      const value = Reflect.get(boardRef.current, prop, receiver);
      return typeof value === "function" ? value.bind(boardRef.current) : value;
    },
  });

  // Synthetic agent ID for task assignment — background tasks are owned by the TUI agent.
  const tuiAgentId = makeAgentId("koi-tui");

  // --- @koi/tools-bash: Bash execution (auto-sandboxed when OS adapter available) ---
  // createBashToolWithHooks exposes resetCwd() for session reset (agent:clear / session:new).
  //
  // elicit (#1634): when the bash-ast walker classifies a command as
  // too-complex (non-hard-deny), the tool routes it through the same
  // approvalHandler as the permissions middleware. The user sees a
  // dialog asking whether to run the specific command. This closes
  // the full fail-closed loop by replacing the transitional regex
  // fallback with an explicit user decision.
  const bashElicit = async (params: {
    readonly command: string;
    readonly reason: string;
    readonly nodeType?: string;
  }): Promise<boolean> => {
    const reasonPrefix = params.nodeType !== undefined ? ` (${params.nodeType})` : "";
    const decision = await approvalHandler({
      toolId: "Bash",
      input: { command: params.command },
      reason: `AST walker cannot safely analyse this command${reasonPrefix}: ${params.reason}. Approval delegates to the regex TTP classifier for defense-in-depth.`,
    });
    return decision.kind === "allow" || decision.kind === "always-allow";
  };
  const bashHandle = createBashToolWithHooks({
    workspaceRoot: cwd,
    trackCwd: true,
    elicit: bashElicit,
    ...(sandboxAdapter !== undefined && sandboxProfile !== undefined
      ? { sandboxAdapter, sandboxProfile }
      : {}),
  });
  const bashProvider = createSingleToolProvider({
    name: "bash",
    toolName: "Bash",
    createTool: () => bashHandle.tool,
  });

  // --- bash_background: fire-and-forget bash via task board ---
  // getSignal: () => bgController.signal — read at launch time, not at construction.
  // This allows resetSessionState() to rotate bgController: the old signal is aborted
  // (killing prior-session subprocesses) and new tasks get the fresh controller's signal.
  const bashBackgroundProvider = createSingleToolProvider({
    name: "bash-background",
    toolName: "bash_background",
    createTool: () =>
      createBashBackgroundTool({
        taskBoard,
        getBoundBoard: () => boardRef.current,
        agentId: tuiAgentId,
        workspaceRoot: cwd,
        getSignal: () => bgController.signal,
        onSubprocessStart: () => {
          liveSubprocessCount++;
        },
        onSubprocessEnd: () => {
          liveSubprocessCount--;
        },
        elicit: bashElicit,
        ...(sandboxAdapter !== undefined && sandboxProfile !== undefined
          ? { sandboxAdapter, sandboxProfile }
          : {}),
      }),
  });

  // --- @koi/task-tools: task management tools (task_create, task_get, etc.) ---
  const taskToolProviders = createTaskTools({
    board: taskBoard,
    agentId: tuiAgentId,
  }).map((tool) =>
    createSingleToolProvider({
      name: `task-${tool.descriptor.name}`,
      toolName: tool.descriptor.name,
      createTool: () => tool,
    }),
  );

  // --- @koi/tools-web: web_fetch ---
  // HTTPS allowed: the TUI is a developer tool used on trusted networks.
  // Residual TOCTOU SSRF risk documented in WebExecutorConfig.allowHttps.
  const webExecutor = createWebExecutor({ allowHttps: true });
  const webProvider = createWebProvider({
    executor: webExecutor,
    policy: DEFAULT_UNSANDBOXED_POLICY,
    // Fetch only — no search provider configured (no API key at this layer)
    operations: ["fetch"],
  });

  // --- @koi/tool-notebook: .ipynb read/add/replace/delete ---
  const notebookConfig = { cwd };
  const notebookReadTool = createNotebookReadTool(notebookConfig);
  const notebookAddCellTool = createNotebookAddCellTool(notebookConfig);
  const notebookReplaceCellTool = createNotebookReplaceCellTool(notebookConfig);
  const notebookDeleteCellTool = createNotebookDeleteCellTool(notebookConfig);
  const notebookProviders = [
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
    createSingleToolProvider({
      name: "notebook-replace-cell",
      toolName: "notebook_replace_cell",
      createTool: () => notebookReplaceCellTool,
    }),
    createSingleToolProvider({
      name: "notebook-delete-cell",
      toolName: "notebook_delete_cell",
      createTool: () => notebookDeleteCellTool,
    }),
  ];

  // --- @koi/memory-tools: in-memory memory backend ---
  // Same pattern as golden-query recording: in-memory Map-based backend.
  // Provides memory_store, memory_recall, memory_search, memory_delete tools.
  const memoryBackend = createInMemoryMemoryBackend();
  const memoryProviderResult = createMemoryToolProvider({
    backend: memoryBackend,
    memoryDir: join(tmpdir(), "koi-tui-memory"),
  });
  const memoryProvider = memoryProviderResult.ok ? memoryProviderResult.value : undefined;

  // --- @koi/spawn-tools: agent_spawn (error stub — spawning not supported in TUI) ---
  // Returns a hard error so the model knows spawning failed and can fall back.
  // Full spawning requires agent-runtime + harness wiring.
  const stubSpawnFn: SpawnFn = async (request) => ({
    ok: false,
    error: {
      code: "EXTERNAL",
      message: `agent_spawn is not available in koi tui. Cannot delegate to "${request.agentName}". Complete the task directly instead of spawning.`,
      retryable: false,
    },
  });
  const spawnToolsAll = createSpawnTools({
    spawnFn: stubSpawnFn,
    board: taskBoard,
    agentId: tuiAgentId,
    signal: bgController.signal,
  });
  const spawnToolProviders = spawnToolsAll.map((tool) =>
    createSingleToolProvider({
      name: `spawn-${tool.descriptor.name}`,
      toolName: tool.descriptor.name,
      createTool: () => tool,
    }),
  );

  // --- @koi/skills-runtime + @koi/skill-tool: on-demand skill discovery and loading ---
  // Three-tier discovery: bundled → user (~/.claude/skills) → project (.claude/skills).
  // Project skills shadow user skills which shadow bundled skills.
  //
  // Known limitation: the Skill tool descriptor bakes the skill listing at creation
  // time. After session reset, resolver.load() sees fresh files but the model still
  // sees the old descriptor listing. Full fix requires hot-swappable tool descriptors
  // in createKoi — tracked as a known limitation. The system prompt skill snapshot
  // (built in tui-command.ts) is also static for the process lifetime.
  // AbortController for skill loading — lives for the entire runtime lifetime.
  // Not rotated on session reset (skill loading is stateless file reads).
  const skillAbortController = new AbortController();
  // skillsRuntime is provided by the caller (tui-command.ts) — reuse it for
  // both MCP bridge wiring and the Skill meta-tool.
  const skillToolResult =
    skillsRuntime !== undefined
      ? await createSkillTool({
          resolver: skillsRuntime,
          signal: skillAbortController.signal,
          // No spawnFn — fork-mode skills are filtered out of discovery since the TUI
          // cannot execute them (stubSpawnFn always returns EXTERNAL error).
        })
      : undefined;
  const skillProvider = skillToolResult?.ok
    ? createSingleToolProvider({
        name: "skill",
        toolName: "Skill",
        createTool: () => skillToolResult.value,
      })
    : undefined;

  // --- @koi/middleware-goal: adaptive goal reminders (optional) ---
  // Only installed when the caller provides objectives. Injects goal blocks
  // into model messages and tracks drift/completion across turns.
  const goalMw =
    config.goals !== undefined && config.goals.length > 0
      ? createGoalMiddleware({ objectives: config.goals })
      : undefined;

  // --- Engine adapter: drives model→tool→model loop via runTurn ---
  const transcript: InboundMessage[] = [];
  const engineAdapter = createTranscriptAdapter({
    engineId: "koi-tui",
    modelAdapter,
    transcript,
    maxTranscriptMessages: MAX_TRANSCRIPT_MESSAGES,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  // --- @koi/middleware-exfiltration-guard: block secret exfiltration ---
  // Intercepts tool inputs and network requests, redacting/blocking patterns
  // that match known secret formats (API keys, tokens, credentials).
  // Must be in the middleware stack to protect shell and web_fetch from leaking
  // workspace secrets — omitting it is a security regression.
  const exfiltrationGuardMw = createExfiltrationGuardMiddleware();

  // --- @koi/rules-loader: discover and inject hierarchical project rules ---
  // Walks from cwd to git root, merges CLAUDE.md / AGENTS.md / .koi/context.md
  // into the system prompt on every model call. Uses process.cwd() by default
  // so rules follow the workspace root.
  const rulesMw = createRulesMiddleware({ cwd });

  // --- @koi/middleware-extraction: extract learnings from spawn tool outputs ---
  // Wraps the in-memory memory backend as a MemoryComponent for the extraction
  // middleware. Extracted learnings are stored as standard MemoryRecord entries.
  const extractionMw = createExtractionMiddleware({
    memory: {
      async recall() {
        const result = await memoryBackend.recall("", undefined);
        if (!result.ok) return [];
        return result.value.map((r: MemoryRecord) => ({
          content: r.content,
          score: 1.0,
          record: r,
        }));
      },
      async store(content: string, options?: { readonly category?: string | undefined }) {
        memoryBackend.store({
          name: `extracted-${Date.now()}`,
          description: options?.category ?? "extracted learning",
          type: "feedback",
          content,
        });
      },
    },
  });

  // --- Optional middleware: system prompt + session transcript (C3-A) ---
  // These are provided by the caller (tui-command.ts) so the runtime factory
  // doesn't need to know about session storage paths or prompt content.
  const optionalMiddleware = [
    ...(config.systemPrompt !== undefined
      ? [createSystemPromptMiddleware(config.systemPrompt)]
      : []),
    ...(config.session !== undefined
      ? [
          createSessionTranscriptMiddleware({
            transcript: config.session.transcript,
            sessionId: config.session.sessionId,
          }),
        ]
      : []),
  ];

  // --- Wrap middleware with trace for full ATIF instrumentation ---
  // Same pattern as golden-query recording: each middleware hook invocation
  // (wrapModelCall, wrapToolCall, wrapModelStream) is recorded as an ATIF step,
  // showing MW:permissions, MW:hooks, MW:exfiltration-guard triggered events.
  // Event-trace itself is excluded (TRACE_EXCLUDED set in trace-wrapper.ts).
  const allMiddleware = [
    eventTraceMw,
    hookMw,
    hookObserverMw,
    rulesMw,
    permMw,
    exfiltrationGuardMw,
    extractionMw,
    semanticRetryMw,
    ...(goalMw !== undefined ? [goalMw] : []),
    ...optionalMiddleware,
  ];
  // Monotonic counter for trace timestamps — avoids ATIF store batch dedup
  // when multiple MW spans complete within the same Date.now() millisecond.
  // The store's idempotent dedup uses stepIndex:timestamp as the batch token;
  // all trace wrapper steps use stepIndex=0, so identical timestamps cause
  // silent drops. A monotonic counter ensures unique tokens.
  // let: mutable — incremented on each trace step
  let traceCounter = Date.now();
  const tracedMiddleware = allMiddleware.map((mw) =>
    wrapMiddlewareWithTrace(mw, {
      store: trajectoryStore,
      docId: TUI_DOC_ID,
      clock: () => traceCounter++,
    }),
  );

  // --- Assemble runtime via createKoi ---
  const runtime = await createKoi({
    manifest: { name: "koi-tui", version: "0.1.0", model: { name: modelName } },
    adapter: engineAdapter,
    middleware: tracedMiddleware,
    providers: [
      builtinSearchProvider,
      fsReadProvider,
      fsWriteProvider,
      fsEditProvider,
      bashProvider,
      bashBackgroundProvider,
      ...taskToolProviders,
      webProvider,
      ...notebookProviders,
      ...(memoryProvider !== undefined ? [memoryProvider] : []),
      ...spawnToolProviders,
      ...(mcpSetup !== undefined ? [mcpSetup.provider] : []),
      ...(pluginMcpSetup !== undefined ? [pluginMcpSetup.provider] : []),
      ...(skillProvider !== undefined ? [skillProvider] : []),
    ],
    approvalHandler,
    loopDetection: false,
  });

  return {
    runtime,
    transcript,
    sandboxActive: osSandboxResult.ok,
    getTrajectorySteps: async () => {
      const steps = await trajectoryStore.getDocument(TUI_DOC_ID);
      // Cap at MAX_TRAJECTORY_STEPS — return the most recent steps.
      // Full trajectory is preserved in the store; only the view is capped.
      return steps.length > MAX_TRAJECTORY_STEPS ? steps.slice(-MAX_TRAJECTORY_STEPS) : steps;
    },
    resetSessionState: async (signal: AbortSignal) => {
      // C4-A: Fail fast if caller forgot to abort the active run first.
      if (!signal.aborted) {
        throw new Error(
          "resetSessionState: active AbortSignal must be aborted before resetting. " +
            "Call controller.abort() first to cancel in-flight tool calls.",
        );
      }

      // 1. Reset Bash tracked cwd so the new session starts from workspaceRoot.
      bashHandle.resetCwd();

      // 1b. Clear in-memory memory backend so prior-session memories
      //     don't leak into the new session via memory_recall/memory_search.
      memoryBackend.clear();

      // 2. Abort prior-session background subprocesses (SIGTERM→SIGKILL) and
      //    rotate the controller so new background tasks use a fresh signal.
      //    Wait for the SIGKILL escalation window so old jobs can't mutate
      //    the workspace after reset completes (same pattern as shutdown).
      const hadLiveProcesses = liveSubprocessCount > 0;
      bgController.abort();
      bgController = new AbortController();
      if (hadLiveProcesses) {
        await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
      }

      // 3. Clear session-scoped approval state (always-allow, caches, trackers).
      permMw.clearSessionApprovals(runtime.sessionId);

      // 4. Rotate task board — AWAITED so new-session submits can't hit the old board.
      const newBoard = await createManagedTaskBoard({
        store: createMemoryTaskBoardStore(),
        resultsDir: TASK_RESULTS_DIR,
      });
      boardRef.current = newBoard;

      // 5. Clear trajectory store — AWAITED so new-session steps can't be pruned.
      //
      // Known limitation: goal middleware state and skill surfaces are NOT reset
      // on session:new / agent:clear. Goal state (completed items, reminder
      // backoff, drift) persists across TUI session resets. Skill descriptor
      // listing and system prompt skill snapshot are static for the process
      // lifetime. Both require a full TUI restart to refresh.
      //
      // Manual lifecycle hook cycling (onSessionEnd/onSessionStart) is unsafe
      // here because the aborted run's engine finally block also calls
      // onSessionEnd on the same sessionId, creating a race that can delete
      // freshly-initialized goal state. Rebuilding the runtime on reset would
      // fix both, but requires createKoi to support hot-swapping — tracked as
      // a known limitation.
      await trajectoryStore.prune(Date.now() + 86_400_000);
    },
    hasActiveBackgroundTasks: () => liveSubprocessCount > 0,
    shutdownBackgroundTasks: () => {
      // Abort the current controller — triggers SIGTERM→SIGKILL for all
      // in-flight bash_background subprocesses.
      // Returns true if subprocesses were live so the caller can wait for the
      // SIGKILL escalation window before process.exit().
      // Uses the authoritative live-subprocess counter, not task-board state
      // (task_stop can change board state without killing the OS process).
      const hadTasks = liveSubprocessCount > 0;
      bgController.abort();
      mcpSetup?.dispose();
      pluginMcpSetup?.dispose();
      return hadTasks;
    },
  };
}
