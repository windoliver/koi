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
 *
 * MCP transport wiring is deferred — tracked as a follow-up to #1542.
 * Hook loading from user config is deferred — currently passes empty hooks.
 *
 * Returns the KoiRuntime, the mutable transcript array (for session resets),
 * and a getTrajectorySteps() accessor for the /trajectory TUI command.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalHandler,
  InboundMessage,
  ManagedTaskBoard,
  ModelAdapter,
  RichTrajectoryStep,
  TrajectoryDocumentStore,
} from "@koi/core";
import {
  createSingleToolProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  agentId as makeAgentId,
} from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createLocalFileSystem } from "@koi/fs-local";
import { createHookMiddleware } from "@koi/hooks";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { createOsAdapter, mergeProfile, restrictiveProfile } from "@koi/sandbox-os";
import { createTaskTools } from "@koi/task-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createBashBackgroundTool, createBashTool } from "@koi/tools-bash";
import {
  createBuiltinSearchProvider,
  createFsEditTool,
  createFsReadTool,
  createFsWriteTool,
} from "@koi/tools-builtin";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { createTranscriptAdapter } from "./engine-adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum trajectory steps retained in the in-memory store for /trajectory view. */
export const MAX_TRAJECTORY_STEPS = 200;

/** Document ID used for TUI session trajectory storage. */
const TUI_DOC_ID = "koi-tui-session";

/** Maximum model→tool→model turns per user submit in the TUI. */
const DEFAULT_MAX_TURNS = 10;

/** Maximum messages retained in the transcript context window. */
const MAX_TRANSCRIPT_MESSAGES = 20;

/**
 * Temp directory for task result storage. Enables `task_update(status="completed")`
 * by making `hasResultPersistence()` return true. Results survive the session but
 * not reboots — acceptable for interactive TUI sessions.
 */
const TASK_RESULTS_DIR = join(tmpdir(), "koi-tui-task-results");

// ---------------------------------------------------------------------------
// In-memory trajectory store
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory TrajectoryDocumentStore.
 *
 * Used by event-trace middleware to record model/tool steps. No disk I/O —
 * the TUI reads steps back via getTrajectorySteps() for the /trajectory view.
 */
function createInMemoryTrajectoryStore(): TrajectoryDocumentStore {
  // Map<docId, steps[]> — documents accumulate across the session lifetime
  const documents = new Map<string, RichTrajectoryStep[]>();

  return {
    async append(docId, steps) {
      const existing = documents.get(docId) ?? [];
      documents.set(docId, [...existing, ...steps]);
    },
    async getDocument(docId) {
      return documents.get(docId) ?? [];
    },
    async getStepRange(docId, startIndex, endIndex) {
      return (documents.get(docId) ?? []).slice(startIndex, endIndex);
    },
    async getSize(docId) {
      // Approximate size in bytes for eviction heuristics
      return JSON.stringify(documents.get(docId) ?? []).length;
    },
    async prune(_olderThanMs) {
      // In-memory store doesn't prune by timestamp — cleared by GC on session end
      return 0;
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
   * **IMPORTANT — ordering constraint**: callers MUST abort the active run's
   * AbortController (e.g. `activeController.abort()`) BEFORE calling this method.
   * The task-board rotation is async (fire-and-forget) to avoid blocking the UI.
   * Aborting the run first ensures all in-flight tool calls are cancelled before
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
   */
  readonly resetSessionState: () => void;
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Assemble the full L2 tool stack for `koi tui` via createKoi.
 *
 * Blueprint: record-cassettes.ts — this is the same composition used in
 * golden query recording, simplified to the TUI's surface (no ATIF file writes,
 * no hook agent executor, no MCP server lifecycle).
 */
export async function createTuiRuntime(config: TuiRuntimeConfig): Promise<TuiRuntimeHandle> {
  const { modelAdapter, modelName, approvalHandler, cwd = process.cwd() } = config;

  // --- Trajectory store (in-memory, no disk I/O) ---
  const trajectoryStore = createInMemoryTrajectoryStore();

  // --- @koi/event-trace: record model/tool I/O for /trajectory view ---
  const { middleware: eventTraceMw } = createEventTraceMiddleware({
    store: trajectoryStore,
    docId: TUI_DOC_ID,
    agentName: "koi-tui",
    agentVersion: "0.1.0",
  });

  // --- @koi/hooks: command hook dispatch ---
  // No hooks loaded from config yet — deferred to a follow-up task.
  // Empty hooks = hook middleware is present (for trajectory recording) but a no-op.
  const hookMw = createHookMiddleware({ hooks: [] });

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

  // Proxy delegates all ManagedTaskBoard method calls to boardRef.current.
  // Replacing boardRef.current on session reset makes prior tasks invisible to
  // the new session's task_list / task_get / task_output calls.
  const taskBoard: ManagedTaskBoard = {
    snapshot: () => boardRef.current.snapshot(),
    nextId: () => boardRef.current.nextId(),
    add: (input) => boardRef.current.add(input),
    addAll: (inputs) => boardRef.current.addAll(inputs),
    assign: (taskId, agentId) => boardRef.current.assign(taskId, agentId),
    unassign: (taskId) => boardRef.current.unassign(taskId),
    startTask: (taskId, agentId) => boardRef.current.startTask(taskId, agentId),
    hasResultPersistence: () => boardRef.current.hasResultPersistence(),
    complete: (taskId, result) => boardRef.current.complete(taskId, result),
    completeOwnedTask: (taskId, agentId, result) =>
      boardRef.current.completeOwnedTask(taskId, agentId, result),
    fail: (taskId, error) => boardRef.current.fail(taskId, error),
    failOwnedTask: (taskId, agentId, error) =>
      boardRef.current.failOwnedTask(taskId, agentId, error),
    kill: (taskId) => boardRef.current.kill(taskId),
    killOwnedTask: (taskId, agentId) => boardRef.current.killOwnedTask(taskId, agentId),
    update: (taskId, patch) => boardRef.current.update(taskId, patch),
    updateOwned: (taskId, agentId, patch) => boardRef.current.updateOwned(taskId, agentId, patch),
    [Symbol.asyncDispose]: async () => {
      // Lifecycle is managed externally (boardRef.current) — proxy is a no-op here
    },
  };

  // Synthetic agent ID for task assignment — background tasks are owned by the TUI agent.
  const tuiAgentId = makeAgentId("koi-tui");

  // --- @koi/tools-bash: Bash execution (auto-sandboxed when OS adapter available) ---
  const bashTool = createBashTool({
    workspaceRoot: cwd,
    trackCwd: true,
  });
  const bashProvider = createSingleToolProvider({
    name: "bash",
    toolName: "Bash",
    createTool: () => bashTool,
  });

  // --- bash_background: fire-and-forget bash via task board ---
  const { tool: bashBackgroundTool, dispose: disposeBashBackground } = createBashBackgroundTool({
    board: taskBoard,
    agentId: tuiAgentId,
    workspaceRoot: cwd,
  });
  const bashBackgroundProvider = createSingleToolProvider({
    name: "bash-background",
    toolName: "BashBackground",
    createTool: () => bashBackgroundTool,
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

  // --- Assemble runtime via createKoi ---
  const runtime = await createKoi({
    manifest: { name: "koi-tui", version: "0.1.0", model: { name: modelName } },
    adapter: engineAdapter,
    middleware: [eventTraceMw, hookMw, permMw, exfiltrationGuardMw],
    providers: [
      builtinSearchProvider,
      fsReadProvider,
      fsWriteProvider,
      fsEditProvider,
      bashProvider,
      bashBackgroundProvider,
      ...taskToolProviders,
      webProvider,
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
    resetSessionState: () => {
      // 1. Reset Bash tracked cwd — not available in current API; new tool
      //    instance would be needed. Tracked cwd resets on next session naturally
      //    since we don't persist it across sessions.

      // 2. Abort prior-session background subprocesses (SIGTERM→SIGKILL).
      disposeBashBackground();

      // 3. Clear session-scoped approval state (always-allow, caches, trackers)
      //    so prior-session approvals do not silently carry into the new session.
      //    The runtime reuses the same factorySessionId across session resets —
      //    explicitly clearing via the middleware handle is the only way to revoke
      //    approvals without recreating the entire runtime.
      permMw.clearSessionApprovals(runtime.sessionId);

      // 4. Rotate task board: swap boardRef.current to a fresh in-memory board.
      //    Prior-session tasks are abandoned with the old board — not discoverable
      //    by the new session's task_list / task_get / task_output calls.
      //    createManagedTaskBoard is async but resolves in <1 ms for in-memory stores
      //    (no disk I/O). Between the call and resolution, the proxy still points
      //    to the old board; since session reset clears the transcript, no concurrent
      //    tool calls are expected in that window.
      //    runBackground() fire-and-forget closures that complete after the rotation
      //    write to boardRef.current (the new board), which won't have the old task —
      //    completeOwnedTask/failOwnedTask return ok:false and are caught gracefully.
      void createManagedTaskBoard({
        store: createMemoryTaskBoardStore(),
        resultsDir: TASK_RESULTS_DIR,
      }).then((newBoard) => {
        boardRef.current = newBoard;
      });
    },
    hasActiveBackgroundTasks: () => false, // TODO: wire subprocess counter
    shutdownBackgroundTasks: () => {
      disposeBashBackground();
      return false;
    },
  };
}
