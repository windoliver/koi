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

import { appendFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "@koi/checkpoint";
import { createConfigManager } from "@koi/config";
import type {
  ApprovalHandler,
  InboundMessage,
  KoiMiddleware,
  ModelAdapter,
  PermissionBackend,
  RichTrajectoryStep,
  SessionId,
  SessionTranscript,
} from "@koi/core";
import { agentId as makeAgentId } from "@koi/core";
import type { DecisionLedgerReader } from "@koi/decision-ledger";
import { createDecisionLedger } from "@koi/decision-ledger";
import type { KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import type { PromptModelCaller } from "@koi/hook-prompt";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import { createGoalMiddleware } from "@koi/middleware-goal";
import type { OtelMiddlewareConfig } from "@koi/middleware-otel";
import type { ApprovalStore } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { wrapMiddlewareWithTrace } from "@koi/runtime";
import type { SkillsRuntime } from "@koi/skills-runtime";
import { composeRuntimeMiddleware } from "./compose-middleware.js";
import { budgetConfigForModel, createTranscriptAdapter } from "./engine-adapter.js";
import { loadPluginComponents } from "./plugin-activation.js";
import { activateStacks, LATE_PHASE_HOST_KEYS, mergeStackContributions } from "./preset-stacks.js";
import {
  buildCoreMiddleware,
  buildCoreProviders,
  loadUserRegisteredHooks,
  mergeUserAndPluginHooks,
} from "./shared-wiring.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import { MAX_TRAJECTORY_STEPS } from "./preset-stacks/observability.js";

/**
 * Maximum trajectory steps retained in the in-memory store for
 * `/trajectory` view. Re-exported so host commands can import the cap
 * alongside `createKoiRuntime`. Source of truth is the observability
 * preset stack.
 */
export { MAX_TRAJECTORY_STEPS };

/** Maximum model→tool→model turns per user submit in the TUI. */
const DEFAULT_MAX_TURNS = 10;

/** Maximum messages retained in the transcript context window.
 * Matches the default for `koi start --context-window` (100).
 * A lower cap (e.g. 20) causes the model to silently lose context
 * after ~10 exchanges with no compaction to preserve it. */
const MAX_TRANSCRIPT_MESSAGES = 100;

// ---------------------------------------------------------------------------
// Config & return types
// ---------------------------------------------------------------------------

export interface KoiRuntimeConfig {
  /** Model HTTP adapter — its complete/stream terminals are exposed to middleware. */
  readonly modelAdapter: ModelAdapter;
  /** Model name for ATIF metadata. */
  readonly modelName: string;
  /** Approval handler for permission prompts — should be permissionBridge.handler. */
  readonly approvalHandler: ApprovalHandler;
  /**
   * Override the built-in permission backend. When omitted, the factory
   * uses `default`-mode with the TUI's tiered allow rules (pre-allowed
   * read-only tools, everything else falls through to "ask"). Hosts that
   * need a different posture (e.g. `koi start` auto-allows everything
   * because the plain REPL has no interactive approval UI) pass their
   * own backend here.
   */
  readonly permissionBackend?: PermissionBackend | undefined;
  /**
   * Description label for the permissions middleware — shown in error
   * messages and trace steps. Defaults to "koi tui — default permission
   * mode". `koi start` passes "koi start — auto-allow".
   */
  readonly permissionsDescription?: string | undefined;
  /**
   * Stable identifier used as the `hostId` on spawn events, decision-
   * ledger lookups, and permission persistentAgentId. Defaults to
   * "koi-tui" for backward compatibility. `koi start` passes "koi-cli".
   */
  readonly hostId?: string | undefined;
  /**
   * EngineAdapter `engineId` — surfaced in error messages and trace
   * metadata. Defaults to "koi-tui". `koi start` passes "koi-cli".
   */
  readonly engineId?: string | undefined;
  /**
   * Optional loop-mode generation fence for `koi start --until-pass`.
   * When set, the transcript adapter snapshots this at stream-start
   * and skips the commit-on-done path if the generation has advanced
   * (orphan fence, #1624). The TUI never sets this because it has no
   * convergence-loop driver.
   */
  readonly getGeneration?: (() => number) | undefined;
  /**
   * Opt-in subset of preset stacks to activate. When `undefined`
   * (default), every stack in `DEFAULT_STACKS` is activated —
   * matching v1's "wire everything" posture. Hosts that need a
   * stripped-down assembly (e.g. a CI runner without notebook
   * tools) pass an explicit list. Manifest YAML surfaces this
   * through a `stacks:` key; see `loadManifestConfig`.
   */
  readonly stacks?: readonly string[] | undefined;
  /**
   * Observer for spawn lifecycle events emitted by the Spawn tool executor.
   * The TUI bridge hooks this to dispatch spawn_requested and agent_status_changed
   * EngineEvents into the store so /agents and inline spawn_call blocks update.
   */
  readonly onSpawnEvent?:
    | ((event: {
        readonly kind: "spawn_requested" | "agent_status_changed";
        readonly agentId: string;
        readonly agentName: string;
        readonly description: string;
        readonly status?: "running" | "complete" | "failed";
      }) => void)
    | undefined;
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
  /**
   * Persistent approval store for cross-session "always" grants.
   * When provided, durable approvals survive process restart.
   */
  readonly persistentApprovals?: ApprovalStore | undefined;
  /**
   * Pre-constructed model-router middleware. When provided, routes all model
   * calls through the failover chain before reaching the model adapter.
   * Create via: createModelRouterMiddleware(createModelRouter(config, adapters))
   * When omitted, calls go directly to the model adapter (no routing/fallback).
   */
  readonly modelRouterMiddleware?: KoiMiddleware | undefined;
  /**
   * OpenTelemetry middleware config.
   *
   * - `true`  — enable with defaults (tracerName "@koi/middleware-otel", no content capture)
   * - `false` / omitted — disabled
   * - `OtelMiddlewareConfig` — fully customised (meter, tracerName, captureContent, onSpanError)
   *
   * Requires an OTel SDK to be initialised before `createTuiRuntime` is called.
   * In the CLI, set `KOI_OTEL_ENABLED=true` to opt in.
   *
   * @example
   *   otel: true
   * @example
   *   otel: { captureContent: true, meter: myMeter }
   */
  readonly otel?: OtelMiddlewareConfig | true | false | undefined;
}

export interface KoiRuntimeHandle {
  /** The assembled KoiRuntime — call runtime.run(input) to stream a turn. */
  readonly runtime: KoiRuntime;
  /**
   * Checkpoint handle for session-level rollback (#1625). Always populated
   * in the TUI — captures end-of-turn snapshots and exposes rewind() so the
   * `/rewind` slash command can roll back the active session.
   *
   * Snapshots live in an in-memory SQLite chain (per-process, lost on exit);
   * blobs live in a flat tmp dir under `~/.koi/file-history`. The conversation
   * log is shared with the session transcript so /rewind truncates both halves.
   */
  /**
   * Checkpoint handle for session-level rollback — populated when the
   * `checkpoint` preset stack is active (default) and `undefined` when
   * a host disables it via `manifest.stacks`. Hosts that consume this
   * field guard with `?.rewind(...)` so a disabled stack degrades to
   * "/rewind unsupported" rather than a crash.
   */
  readonly checkpoint: Checkpoint | undefined;
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
   * Append a pre-built trajectory step to the session's ATIF document. Used
   * by non-engine code paths that still deserve to appear in /trajectory —
   * notably `/rewind`, which runs `checkpoint.rewind()` directly without
   * going through `runTurn`, so the trace wrapper never sees it.
   */
  readonly appendTrajectoryStep: (step: RichTrajectoryStep) => Promise<void>;
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
  /**
   * Decision ledger factory — creates a per-session ledger reader backed by
   * the in-memory trajectory store. Used by the /trajectory view to show
   * audit entries and source status alongside trajectory steps.
   */
  readonly createDecisionLedger: () => DecisionLedgerReader;
}

// MCP loading has moved to `./shared-wiring.ts` — both `koi start` and
// `koi tui` now call `loadUserMcpSetup` / `buildPluginMcpSetup` from there
// so the `.mcp.json` discovery + SkillsMcpBridge logic lives in one place.

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface ConfigHotReloadHandle {
  readonly dispose: () => void;
}

/**
 * Optional config hot-reload wiring for `@koi/config` (issue #1632).
 *
 * Guarded by the `KOI_CONFIG_PATH` env var — if unset, this is a no-op
 * and nothing changes from the pre-existing TUI behavior. When set to a
 * config file path, instantiates a `ConfigManager`, calls `initialize()`,
 * starts `watch()`, and registers a consumer that logs every reload
 * event to stderr.
 *
 * **This consumer is intentionally log-only.** The TUI does not currently
 * hot-swap any config fields into a running `createKoi` session — that
 * requires `createKoi` to support rebuilding the runtime on reset, which
 * is tracked as a known limitation elsewhere in this file (see the
 * `resetSessionState` comment). The wiring exists to:
 *
 *   1. Smoke-test `@koi/config`'s hot-reload primitives in a real
 *      long-running process, not just in unit tests.
 *   2. Serve as canonical example wiring for downstream consumers (tool
 *      registries, permission evaluators, prompt manifests) that the
 *      follow-up PRs to #1632 will eventually add.
 *   3. Give operators visibility: if they set `KOI_CONFIG_PATH` and edit
 *      the file, they'll see stderr log lines confirming the reload
 *      pipeline fired.
 *
 * Watcher errors and consumer errors are logged through the dedicated
 * `onWatcherError` / `onConsumerError` callbacks so they don't
 * conflate with the regular reload lifecycle events.
 */
async function setupConfigHotReload(): Promise<ConfigHotReloadHandle | undefined> {
  const configPath = process.env.KOI_CONFIG_PATH;
  if (configPath === undefined || configPath === "") return undefined;

  // Optional post-startup visibility: once OpenTUI takes over the terminal,
  // `console.error`/`process.stderr.write` output is buffered and not
  // visible to the user. If the operator wants to observe live reload
  // events during an interactive session, they set KOI_CONFIG_LOG_PATH to
  // a file path and this consumer appends every event there. Startup
  // events (before the TUI renders) are always visible on stderr regardless.
  const logPath = process.env.KOI_CONFIG_LOG_PATH;
  const fileLog = (msg: string): void => {
    if (logPath === undefined || logPath === "") return;
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* swallow — never let a failing log sink break the pipeline */
    }
  };

  const mgr = createConfigManager({
    filePath: configPath,
    onConsumerError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      fileLog(`consumer-failed: ${msg}`);
      console.error(`[koi tui] config consumer failed: ${msg}`);
    },
    onWatcherError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      fileLog(`watcher-error: ${msg}`);
      console.error(`[koi tui] config watcher error: ${msg}`);
    },
  });

  mgr.events.subscribe((event) => {
    // Telemetry fan-out: rejected reloads are always surfaced; applied
    // events are logged to the file sink only when non-empty (spurious
    // fs.watch fires with no real change are too noisy).
    if (event.kind === "rejected") {
      fileLog(`rejected reason=${event.reason} error=${event.error.message}`);
      console.error(`[koi tui] config reload rejected (${event.reason}): ${event.error.message}`);
    } else if (event.kind === "applied" && event.changedPaths.length > 0) {
      fileLog(`applied paths=[${event.changedPaths.join(",")}]`);
    }
  });

  mgr.registerConsumer({
    onConfigChange: ({ changedPaths, prev, next }) => {
      // Log-only consumer. The TUI runtime does not hot-swap config
      // fields into the running session — `createKoi` does not support
      // runtime re-assembly yet (tracked as a known limitation at
      // `resetSessionState` below). For now we log the change so
      // operators can verify the pipeline fires, and the primitive is
      // ready to plug into real consumers in follow-up PRs.
      fileLog(
        `changed paths=[${changedPaths.join(",")}] logLevel=${prev.logLevel}→${next.logLevel}`,
      );
      console.error(
        `[koi tui] config changed [${changedPaths.join(", ")}] ` +
          `logLevel=${prev.logLevel}→${next.logLevel}`,
      );
    },
  });

  fileLog(`setup configPath=${configPath} pid=${process.pid}`);
  const initResult = await mgr.initialize();
  if (initResult.ok) {
    fileLog("initialize ok");
    console.error(`[koi tui] config hot-reload armed on ${configPath}`);
  } else {
    // Initialize failed (file missing, invalid, etc.). The manager's
    // watcher is still armed — when the file is created or fixed, the
    // next onFileEvent retries initialize() automatically. No need to
    // fail TUI startup.
    fileLog(`initialize failed: ${initResult.error.code} ${initResult.error.message}`);
    console.error(
      `[koi tui] config initialize failed (${initResult.error.code}): ${initResult.error.message}`,
    );
  }
  const unsub = mgr.watch();
  fileLog("watcher armed");

  return {
    dispose: () => {
      fileLog("dispose");
      unsub();
      mgr.dispose();
    },
  };
}

/**
 * Assemble the full L2 tool stack via createKoi. This is the shared
 * runtime factory for every host — `koi tui`, `koi start`, and any
 * future frontend. Hosts differ only in their I/O loop and a handful
 * of config knobs (permission backend, approval handler, spawn event
 * hook, persistent approvals). The runtime, middleware stack, and
 * provider set are all identical across hosts so adding a feature in
 * one place lands in every frontend automatically.
 *
 * Blueprint: record-cassettes.ts — this is the same composition used in
 * golden query recording. MCP loaded from .mcp.json when present.
 */
export async function createKoiRuntime(config: KoiRuntimeConfig): Promise<KoiRuntimeHandle> {
  const { modelAdapter, modelName, approvalHandler, cwd = process.cwd(), skillsRuntime } = config;
  // Stable host identifier — used as the persistentAgentId for permissions,
  // the agentName in trajectory metadata, and the [koi/X] log prefix.
  // Pulled up from below so preset stack activation (which runs early so
  // stacks can contribute hookExtras before the hook middleware is built)
  // can thread it into the StackActivationContext.
  const hostId = config.hostId ?? "koi-tui";

  // --- Optional config hot-reload (log-only; guarded by KOI_CONFIG_PATH) ---
  const configHotReload = await setupConfigHotReload();

  // --- Plugin activation: load enabled plugins' hooks, MCP, skills ---
  // Stays inline because it feeds BOTH the pre-stack hook merge AND
  // the MCP stack's server list — it's host bootstrap, not a
  // feature bundle. The MCP preset stack consumes its outputs via
  // `ctx.host[PLUGIN_MCP_SERVERS_HOST_KEY]`.
  const pluginUserRoot = join(homedir(), ".koi", "plugins");
  const pluginComponents = await loadPluginComponents(pluginUserRoot);
  if (pluginComponents.errors.length > 0) {
    for (const err of pluginComponents.errors) {
      console.warn(`[koi/${hostId}] plugin "${err.plugin}": ${err.error}`);
    }
  }
  if (pluginComponents.middlewareNames.length > 0) {
    console.warn(
      `[koi/${hostId}] ${String(pluginComponents.middlewareNames.length)} plugin middleware name(s) skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
    );
  }

  // Register plugin skills with the SkillsRuntime (if any)
  if (skillsRuntime !== undefined && pluginComponents.skillMetadata.length > 0) {
    skillsRuntime.registerExternal(pluginComponents.skillMetadata);
  }

  // Session generation counter — incremented on each reset.
  // The trace wrapper and event-trace MW capture the doc ID at construction
  // and can't be rotated after createKoi assembly. The prune is awaited to
  // minimize the window, but late fire-and-forget appends from the old
  // session's trace can theoretically recreate the pruned document.
  // In practice this window is <1ms (prune completes before new submit).
  // Full fix requires doc-ID rotation which needs API changes to the trace
  // wrapper — tracked as a known limitation.

  // --- Preset stack activation (v1 `activatePresetStacks` pattern) ---
  // Two-phase activation so feature stacks with cross-cutting
  // dependencies (spawn needs already-composed middleware for child
  // inheritance) can compose cleanly:
  //
  //   Phase 1 (early, default) — runs BEFORE the core middleware is
  //     built. Early stacks can contribute `hookExtras.onExecuted`
  //     observer taps (observability) and export state the factory
  //     reads (bashHandle, trajectoryStore, checkpointHandle, etc.).
  //
  //   Phase 2 (late) — runs AFTER the core middleware is assembled.
  //     Late stacks read already-built middleware from `ctx.host`
  //     under `LATE_PHASE_HOST_KEYS`. Spawn is currently the only
  //     late-phase consumer — it needs permissions/hook/exfil/
  //     system-prompt for the child inheritance list.
  //
  // The execution stack needs a synthetic agent id for task
  // assignment and a reference to the caller's approval handler for
  // bash elicit. Both are passed via `ctx.host`.
  const precomputedAgentId = makeAgentId(hostId);
  const enabledStackIds = config.stacks !== undefined ? new Set(config.stacks) : undefined;
  const earlyContextHost: Record<string, unknown> = {
    ...(skillsRuntime !== undefined ? { skillsRuntime } : {}),
    ...(config.otel !== undefined ? { otelConfig: config.otel } : {}),
    approvalHandler,
    agentId: precomputedAgentId,
    modelName,
    pluginMcpServers: pluginComponents.mcpServers,
    ...(config.onSpawnEvent !== undefined ? { onSpawnEvent: config.onSpawnEvent } : {}),
  };
  const earlyContext: import("./preset-stacks.js").StackActivationContext = {
    cwd,
    hostId,
    modelAdapter,
    ...(config.session !== undefined ? { sessionTranscript: config.session.transcript } : {}),
    host: earlyContextHost,
  };
  const earlyContribution = await activateStacks(earlyContext, {
    phase: "early",
    ...(enabledStackIds !== undefined ? { enabled: enabledStackIds } : {}),
  });

  // --- Read observability exports for trace wrapping + handle fields ---
  // Reads from `earlyContribution` because the late phase hasn't run
  // yet — the late-phase merged `stackContribution` is built further
  // below, after the core middleware is assembled.
  const trajectoryStore = earlyContribution.exports.trajectoryStore as
    | import("@koi/core/rich-trajectory").TrajectoryDocumentStore
    | undefined;
  const trajectoryDocId =
    (earlyContribution.exports.trajectoryDocId as string | undefined) ?? "koi-session";

  // --- @koi/hooks: load hooks from ~/.koi/hooks.json + command hook dispatch ---
  // Same loader the CLI host uses, via ./shared-wiring.ts.
  // Absent/unreadable file = no hooks (empty array, middleware is a no-op).
  // Agent hooks (kind: "agent") are filtered out because the TUI does not
  // provide a spawnFn — createHookMiddleware throws if any agent hook is
  // present without one. Prompt hooks (kind: "prompt") are supported via a
  // lightweight PromptModelCaller that delegates to the TUI's model adapter
  // for single-shot verification.
  const loadedHooks = await loadUserRegisteredHooks({
    filterAgentHooks: true,
    onAgentHooksFiltered: (names) => {
      console.warn(
        `[koi tui] ${names.length} agent hook(s) skipped (not supported in TUI): ${names.join(", ")}`,
      );
    },
  });
  // Merge plugin hooks (session tier) with user hooks (user tier).
  // Plugin hooks run first within their tier; user hooks in the next tier phase.
  const allHooks = mergeUserAndPluginHooks(loadedHooks, pluginComponents.hooks, {
    filterAgentHooks: true,
  });

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
  // Hook middleware is built below via `buildCoreMiddleware` (the
  // shared slot factory). Declaring it here would duplicate the
  // construction — the downstream `allMiddleware` array reads
  // `coreSlots.hook` instead.

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
  // Permission backend: caller may override (koi start passes an
  // auto-allow pattern backend). Default to the TUI's tiered default
  // mode so existing TUI behavior is preserved.
  const permBackend =
    config.permissionBackend ??
    createPermissionBackend({
      mode: "default",
      rules: tuiAllowRules,
    });
  const permMw = createPermissionsMiddleware({
    backend: permBackend,
    description: config.permissionsDescription ?? "koi tui — default permission mode",
    ...(config.persistentApprovals !== undefined
      ? { persistentApprovals: config.persistentApprovals, persistentAgentId: hostId }
      : {}),
  });

  // --- Execution stack exports (bash handle + background task state) ---
  // The execution preset stack owns OS sandbox, bash-with-hooks, the
  // mutable bgController, the live subprocess counter, the task board
  // proxy, and the bash_background / task_* tool providers. We just
  // read the exports here for the fields that feed into buildCoreProviders
  // (bashHandle.tool) and the returned KoiRuntimeHandle (sandboxActive,
  // hasActiveBackgroundTasks, shutdownBackgroundTasks).
  const bashHandle = earlyContribution.exports.bashHandle as
    | import("@koi/tools-bash").BashToolHandle
    | undefined;
  const sandboxActive = (earlyContribution.exports.sandboxActive as boolean | undefined) ?? false;
  const _tuiAgentId = precomputedAgentId;

  // --- Core providers (search + fs + web + bash) via shared-wiring ---
  // The shared `buildCoreProviders` helper wires the exact same base set
  // that `koi start` gets, so adding a new "both hosts" tool = one edit.
  // TUI contributes its hooks-enabled Bash variant via the `bashTool` field.
  const coreProviders = buildCoreProviders({
    cwd,
    ...(bashHandle !== undefined ? { bashTool: bashHandle.tool } : {}),
  });

  // --- @koi/skills-runtime + @koi/skill-tool: on-demand skill discovery and loading ---
  // Three-tier discovery: bundled → user (~/.claude/skills) → project (.claude/skills).
  // Project skills shadow user skills which shadow bundled skills.
  //
  // Known limitation: the Skill tool descriptor bakes the skill listing at creation
  // time. After session reset, resolver.load() sees fresh files but the model still
  // sees the old descriptor listing. Full fix requires hot-swappable tool descriptors
  // in createKoi — tracked as a known limitation. The system prompt skill snapshot
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
    engineId: config.engineId ?? "koi-tui",
    modelAdapter,
    transcript,
    maxTranscriptMessages: MAX_TRANSCRIPT_MESSAGES,
    maxTurns: DEFAULT_MAX_TURNS,
    ...(config.getGeneration !== undefined ? { getGeneration: config.getGeneration } : {}),
    budgetConfig: budgetConfigForModel(
      modelName,
      // KOI_COMPACTION_WINDOW: override context window size for testing compaction
      // without changing real model config. E.g.: KOI_COMPACTION_WINDOW=2000
      process.env.KOI_COMPACTION_WINDOW !== undefined
        ? Number(process.env.KOI_COMPACTION_WINDOW)
        : undefined,
    ),
  });

  // --- @koi/middleware-exfiltration-guard: block secret exfiltration ---
  // Intercepts tool inputs and network requests, redacting/blocking patterns
  // that match known secret formats (API keys, tokens, credentials).
  // Must be in the middleware stack to protect shell and web_fetch from leaking
  // workspace secrets — omitting it is a security regression.
  const exfiltrationGuardMw = createExfiltrationGuardMiddleware();

  // --- Core middleware slots (shared with `koi start`) ---
  // `buildCoreMiddleware` is the single source of truth for the
  // permissions / hook / system-prompt / session-transcript factory
  // calls. Each host splices the slots into its own middleware order
  // below. System prompt must be built before spawnToolProvider so
  // children can inherit it; session transcript is NOT inherited
  // (per-runtime mutable state).
  const coreSlots = buildCoreMiddleware({
    permissionsMiddleware: permMw,
    hooks: allHooks,
    // Merge stack-contributed hookExtras (e.g. observability's
    // onExecuted tap for trajectory recording) with host-specific
    // extras (promptCallFn for prompt hooks).
    hookExtras: {
      ...earlyContribution.hookExtras,
      ...(hasPromptHooks ? { promptCallFn } : {}),
    },
    forceHookSlot: true,
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.session !== undefined ? { session: config.session } : {}),
  });
  // Local aliases kept so the downstream trace-wrap array literal and
  // spawn `inheritedMiddleware` array read the same as before.
  // `forceHookSlot: true` above makes `coreSlots.hook` guaranteed
  // non-undefined; the runtime check preserves that invariant without
  // a non-null assertion (banned by CLAUDE.md).
  if (coreSlots.hook === undefined) {
    throw new Error("tui-runtime: coreSlots.hook is undefined despite forceHookSlot:true");
  }
  const hookMw = coreSlots.hook;
  const systemPromptMw = coreSlots.systemPrompt;
  const sessionTranscriptMw = coreSlots.sessionTranscript;

  // --- Late-phase stack activation (spawn + any future late stacks) ---
  // Now that the core middleware is built, publish the child-
  // inheritance list into the late context's `host` bag and fire the
  // late pass. Spawn reads `LATE_PHASE_HOST_KEYS.inheritedMiddleware`
  // and composes its child adapter around it.
  const inheritedMiddlewareForChildren: readonly KoiMiddleware[] = [
    permMw,
    exfiltrationGuardMw,
    hookMw,
    ...(systemPromptMw !== undefined ? [systemPromptMw] : []),
  ];
  const lateContext: import("./preset-stacks.js").StackActivationContext = {
    ...earlyContext,
    host: {
      ...earlyContextHost,
      [LATE_PHASE_HOST_KEYS.inheritedMiddleware]: inheritedMiddlewareForChildren,
    },
  };
  const lateContribution = await activateStacks(lateContext, {
    phase: "late",
    ...(enabledStackIds !== undefined ? { enabled: enabledStackIds } : {}),
  });
  const stackContribution = mergeStackContributions(earlyContribution, lateContribution);

  // --- Checkpoint handle exported by the checkpoint preset stack ---
  // Read here for the returned KoiRuntimeHandle.checkpoint field.
  const checkpointHandle = stackContribution.exports.checkpointHandle as
    | import("@koi/checkpoint").Checkpoint
    | undefined;

  // --- Compose middleware via the standalone `composeRuntimeMiddleware` ---
  // The ordering (outermost → innermost) is defined in one place —
  // compose-middleware.ts. Preset stacks (observability, checkpoint,
  // memory, execution, etc.) plug in via `presetExtras`; the named
  // slots here are the ALWAYS-ON core layers only.
  const allMiddleware = composeRuntimeMiddleware({
    hook: hookMw,
    permissions: permMw,
    exfiltrationGuard: exfiltrationGuardMw,
    ...(config.modelRouterMiddleware !== undefined
      ? { modelRouter: config.modelRouterMiddleware }
      : {}),
    ...(goalMw !== undefined ? { goal: goalMw } : {}),
    presetExtras: stackContribution.middleware,
    ...(systemPromptMw !== undefined ? { systemPrompt: systemPromptMw } : {}),
    ...(sessionTranscriptMw !== undefined ? { sessionTranscript: sessionTranscriptMw } : {}),
  });
  // Wrap every middleware with the trace wrapper when the observability
  // stack is active (provides `trajectoryStore`). When the stack is
  // disabled via `config.stacks` (e.g. a CI runner opting for a
  // minimal assembly), trace wrapping is skipped — the middleware
  // runs without per-span ATIF recording.
  // Monotonic counter avoids Date.now() millisecond collisions on the
  // trace store's idempotent dedup.
  // let: mutable — incremented on each trace step
  let traceCounter = Date.now();
  const tracedMiddleware =
    trajectoryStore !== undefined
      ? allMiddleware.map((mw) =>
          wrapMiddlewareWithTrace(mw, {
            store: trajectoryStore,
            docId: trajectoryDocId,
            clock: () => traceCounter++,
          }),
        )
      : allMiddleware;

  // --- Assemble runtime via createKoi ---
  // When a session is configured, thread `config.session.sessionId` into
  // createKoi as its `sessionId` override so the engine's factory-level
  // session id (used as the JSONL routing key) matches the plain, user-
  // typable UUID the host minted — rather than the default verbose
  // `agent:{agentId}:{uuid}` form. This is what makes the post-quit resume
  // hint short and copy-pasteable.
  const runtime = await createKoi({
    manifest: { name: "koi-tui", version: "0.1.0", model: { name: modelName } },
    adapter: engineAdapter,
    middleware: tracedMiddleware,
    ...(config.session !== undefined ? { sessionId: config.session.sessionId } : {}),
    providers: [...coreProviders, ...stackContribution.providers],
    approvalHandler,
    userId: userInfo().username,
    loopDetection: false,
    // #1742: each user submit in the TUI is a logically fresh request,
    // so opt in to per-iteration budget reset for turn count and
    // duration. Token usage stays CUMULATIVE across the runtime
    // lifetime so the process retains a hard ceiling on total spend.
    //
    // The cumulative token ceiling is raised from the 100k default to
    // 1M — a 10x relaxation, not 50x — because 100k trips inside a
    // single moderately-long TUI session but 1M still bounds runaway
    // tool/model loops well before they become a real cost incident
    // (~$3-15 worst case on Sonnet 4.6). The per-iteration maxTurns:25
    // reset above is the primary loop guard; this token ceiling is the
    // secondary "user keeps submitting expensive prompts" guard.
    //
    // Cost tracking (`maxCostUsd`) is left at the default-disabled
    // value because costPerInputToken/costPerOutputToken default to 0
    // and we don't have a model-aware pricing source wired in. When
    // a host wires real token pricing, also set `cost.maxCostUsd` here
    // for a stricter dollar-denominated cap.
    resetIterationBudgetPerRun: true,
    governance: {
      iteration: {
        // Per-iteration UX budgets (reset on every run via
        // resetIterationBudgetPerRun above):
        maxTurns: 25, // matches DEFAULT_GOVERNANCE_CONFIG
        maxDurationMs: 300_000, // 5 min per submit
        // Cumulative spend ceiling (NOT reset by iteration_reset):
        maxTokens: 1_000_000,
      },
    },
  });

  return {
    runtime,
    checkpoint: checkpointHandle,
    transcript,
    sandboxActive,
    createDecisionLedger: () =>
      createDecisionLedger({
        // The observability stack stores all trajectory data under a
        // fixed doc ID. When the stack is disabled, the ledger gets a
        // stub that reports empty — decision view shows nothing but
        // nothing breaks.
        trajectoryStore: {
          getDocument: () =>
            trajectoryStore !== undefined
              ? trajectoryStore.getDocument(trajectoryDocId)
              : Promise.resolve([]),
        },
      }),
    getTrajectorySteps: async () => {
      if (trajectoryStore === undefined) return [];
      const steps = await trajectoryStore.getDocument(trajectoryDocId);
      // Cap at MAX_TRAJECTORY_STEPS — return the most recent steps.
      return steps.length > MAX_TRAJECTORY_STEPS ? steps.slice(-MAX_TRAJECTORY_STEPS) : steps;
    },
    appendTrajectoryStep: async (step: RichTrajectoryStep): Promise<void> => {
      if (trajectoryStore === undefined) return;
      await trajectoryStore.append(trajectoryDocId, [step]);
    },
    resetSessionState: async (signal: AbortSignal) => {
      // C4-A: Fail fast if caller forgot to abort the active run first.
      if (!signal.aborted) {
        throw new Error(
          "resetSessionState: active AbortSignal must be aborted before resetting. " +
            "Call controller.abort() first to cancel in-flight tool calls.",
        );
      }

      // 1. Cycle middleware session lifecycle BEFORE destructive cleanup.
      //    This awaits the in-flight run's settle (bounded by ~5s in the
      //    engine). On success the prior run is fully unwound. On settle
      //    timeout / onSessionEnd failure cycleSession throws — we
      //    propagate so callers surface a "restart required" error and
      //    the prior session stays inspectable. NO destructive cleanup
      //    has happened yet.
      //
      //    Capture the OLD sessionId before the cycle so we can clear
      //    the prior session's permission state below. cycleSession()
      //    rotates `runtime.sessionId`; reading it after rotation would
      //    target the empty new session and leak old approvals.
      const priorSessionId = runtime.sessionId;
      await runtime.cycleSession?.();

      // 2. Fire stack-contributed reset hooks. Each preset stack clears
      //    its own session-scoped state: observability prunes the
      //    trajectory store, memory wipes the backend, execution aborts
      //    the bgController, waits for subprocess drain, resets bash
      //    CWD, rotates the controller, and atomically swaps the task
      //    board. Run sequentially so failures stay isolated but
      //    ordered; swallow individual errors so one wedged stack can't
      //    block siblings.
      for (const hook of stackContribution.resetSessionHooks) {
        try {
          await hook(signal);
        } catch (hookErr) {
          console.warn(
            `[koi/${hostId}] preset stack onResetSession hook failed: ${
              hookErr instanceof Error ? hookErr.message : String(hookErr)
            }`,
          );
        }
      }

      // 3. Clear the OLD session's approval state (always-allow, caches,
      //    trackers). Not a stack concern — permissions is a core slot.
      permMw.clearSessionApprovals(priorSessionId);
    },
    hasActiveBackgroundTasks: () =>
      stackContribution.activeWorkPredicates.some((predicate) => predicate()),
    shutdownBackgroundTasks: () => {
      // Fire every stack's onShutdown hook and OR their "had live
      // work" return values. Execution stack aborts its bgController
      // and returns true when bash_background subprocesses were live;
      // other stacks currently contribute no shutdown hooks.
      let hadWork = false;
      for (const hook of stackContribution.shutdownHooks) {
        try {
          if (hook()) hadWork = true;
        } catch (hookErr) {
          console.warn(
            `[koi/${hostId}] preset stack onShutdown hook failed: ${
              hookErr instanceof Error ? hookErr.message : String(hookErr)
            }`,
          );
        }
      }
      // configHotReload is factory-bootstrap, not a stack feature —
      // dispose directly.
      configHotReload?.dispose();
      return hadWork;
    },
  };
}

// ---------------------------------------------------------------------------
// Backward-compat aliases
//
// `tui-command.ts` imports `createTuiRuntime`, `TuiRuntimeConfig`, and
// `TuiRuntimeHandle`. The factory was renamed to `createKoiRuntime` /
// `KoiRuntimeConfig` / `KoiRuntimeHandle` because it now serves every
// host. These aliases keep the old names live.
// ---------------------------------------------------------------------------

export type TuiRuntimeConfig = KoiRuntimeConfig;
export type TuiRuntimeHandle = KoiRuntimeHandle;
/** @deprecated Use `createKoiRuntime` — kept for tui-command.ts compat. */
export const createTuiRuntime: (config: KoiRuntimeConfig) => Promise<KoiRuntimeHandle> =
  createKoiRuntime;
