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
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";
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
import { resolveFsPath } from "@koi/fs-local";
import type { PromptModelCaller } from "@koi/hook-prompt";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import { createGoalMiddleware } from "@koi/middleware-goal";
import type { OtelMiddlewareConfig } from "@koi/middleware-otel";
import type { ApprovalStore } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { wrapMiddlewareWithTrace } from "@koi/runtime";
import type { SkillsRuntime } from "@koi/skills-runtime";
import {
  buildInheritedMiddlewareForChildren,
  composeRuntimeMiddleware,
} from "./compose-middleware.js";
import { budgetConfigForModel, createTranscriptAdapter } from "./engine-adapter.js";
import type { ManifestMiddlewareEntry } from "./manifest.js";
import {
  canonicalizeAuditSinkPath,
  createBuiltinManifestRegistry,
  type ManifestMiddlewareContext,
  type MiddlewareRegistry,
  resolveManifestMiddleware,
} from "./middleware-registry.js";
import type { PluginDiscoverySummary } from "./plugin-activation.js";
import { loadPluginComponents } from "./plugin-activation.js";
import { activateStacks, LATE_PHASE_HOST_KEYS, mergeStackContributions } from "./preset-stacks.js";
import { enforceRequiredMiddleware } from "./required-middleware.js";
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

/**
 * Maximum model→tool→model turns per user submit in the TUI.
 *
 * Bumped from 10 → 25 so that exploratory flows (the model running multiple
 * small probes before answering) can finish instead of truncating mid-probe
 * with a "Turn ended: max-turns budget reached" synthetic message. 25 matches
 * the kernel/engine-loop default (`packages/drivers/engine-loop/... DEFAULT_MAX_TURNS`)
 * and keeps runaway agent loops bounded on the same order as before.
 */
const DEFAULT_MAX_TURNS = 25;

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
   * Opt-in allowlist of plugin names to activate. When `undefined`
   * (default), every plugin discovered in `~/.koi/plugins/` is
   * activated — matches the prior filesystem-scan behavior. An
   * empty array disables every plugin (useful for reproducible CI
   * assemblies). Manifest YAML surfaces this through a `plugins:`
   * key; see `loadManifestConfig`.
   */
  readonly plugins?: readonly string[] | undefined;
  /**
   * Zone B — ordered, user-controlled middleware resolved from
   * `manifest.middleware`. Each entry names a middleware registered
   * in `middlewareRegistry` and carries optional factory options.
   * Order is authoritative within zone B; the resolved chain
   * always sits between zone A (preset stacks) and zone C
   * (required core), per `composeRuntimeMiddleware`.
   *
   * Unknown names throw `UnknownManifestMiddlewareError` at factory
   * time with the full registered-name list. Core middleware names
   * (`hook`, `permissions`, `exfiltration-guard`, etc.) are rejected
   * earlier by the manifest loader and never reach this field.
   */
  readonly manifestMiddleware?: readonly ManifestMiddlewareEntry[] | undefined;
  /**
   * Registry used to resolve `manifestMiddleware` entry names to
   * concrete factories. When omitted, the factory constructs
   * `createBuiltinManifestRegistry({allowFileBackedSinks: config.allowManifestFileSinks})`.
   * Pass `createDefaultManifestRegistry()` for an empty registry
   * when you want full control over the available names (useful
   * for tests or plugins), or pass a custom populated registry to
   * register host-specific factories.
   */
  readonly middlewareRegistry?: MiddlewareRegistry | undefined;
  /**
   * Host-controlled opt-in for file-backed manifest middleware
   * (currently only `@koi/middleware-audit`, which creates an
   * NDJSON sink at resolution time). Default: `false`.
   *
   * When `false`, the default built-in registry does NOT register
   * `@koi/middleware-audit`, so manifest entries naming it throw
   * `UnknownManifestMiddlewareError`. When `true`, the audit
   * middleware is available subject to path validation.
   *
   * Repo-authored `koi.yaml` cannot flip this flag — it is passed
   * programmatically by the host (CLI flag, env var, or
   * out-of-band policy). Letting committed manifests trigger
   * filesystem side effects is a trust-boundary regression we
   * deliberately avoid.
   */
  readonly allowManifestFileSinks?: boolean | undefined;
  /**
   * Host capability flag consumed by the required-middleware
   * enforcer. Terminal-capable runtimes (e.g. `koi tui`, `koi
   * start`) ship interactive shell / bash / web_fetch and must
   * boot with the full security baseline: `hooks`, `permissions`,
   * `exfiltration-guard`. Headless / CI runtimes (analysis agents,
   * programmatic embedders) only require `hooks` and may omit
   * the terminal-only layers.
   *
   * Defaults to `true` — the conservative posture that matches
   * the existing terminal hosts. Embedders assembling a headless
   * runtime pass `false` explicitly, and the enforcer relaxes
   * the baseline accordingly.
   */
  readonly terminalCapable?: boolean | undefined;
  /**
   * Engine loop-detection override. Passed verbatim to `createKoi`.
   *
   * - `undefined` (default) → the engine's default detector runs,
   *   bounding runaway tool-call spirals per `runTurn` invocation.
   *   This is the correct posture for `koi start` where the auto-
   *   allow permission backend doesn't gate repeated side-effecting
   *   retries interactively.
   * - `false` → disables detection entirely. `koi tui` opts in
   *   because its per-submit iteration budget reset
   *   (`resetIterationBudgetPerRun: true` below, combined with the
   *   governance caps) already bounds spirals and false positives
   *   are expensive inside an interactive session.
   * - `Partial<LoopDetectionConfig>` → custom thresholds for hosts
   *   that need finer-grained tuning.
   */
  readonly loopDetection?: false | Partial<import("@koi/engine").LoopDetectionConfig> | undefined;
  /**
   * When `false`, the execution preset stack skips the
   * `bash_background` provider (detached shell subprocesses). The
   * core `Bash` tool and the full `task_*` tool set (task_create,
   * task_list, task_delegate, task_output, task_stop) stay wired
   * regardless, because spawned coordinator agents depend on
   * task-board orchestration for fan-out/result-collection flows
   * that don't involve background shell subprocesses.
   *
   * `koi start` passes `false` because its auto-allow permission
   * backend + the engine's default loop detector trip on legitimate
   * `task_output` polling of long-running `bash_background` jobs,
   * and the cleanest resolution is to not expose detached
   * subprocesses on the CLI at all. `koi tui` leaves this at the
   * default (true) because its interactive surface makes
   * long-running background work observable. Defaults to `true`.
   */
  readonly backgroundSubprocesses?: boolean | undefined;
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

  /**
   * Opt-in security-grade audit logging via `@koi/middleware-audit` +
   * `@koi/audit-sink-ndjson`. When set, every model/tool call is recorded
   * as a hash-chained NDJSON entry at this path.
   *
   * The TUI surfaces this via the `KOI_AUDIT_NDJSON` environment variable
   * — set to an absolute file path before launching `koi tui`. Any
   * existing file is appended to. Sink resources (writer, timer) are
   * owned by the runtime and closed during shutdown.
   */
  readonly auditNdjsonPath?: string | undefined;
  /**
   * Subset of filesystem operations to expose (#1777). `undefined`
   * means "all three" (`fs_read`/`fs_write`/`fs_edit`). Hosts that
   * honor a `manifest.filesystem.operations` gate pass the resolved
   * list through here. Honored by `buildCoreProviders`.
   */
  readonly filesystemOperations?: readonly ("read" | "write" | "edit")[] | undefined;
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
  readonly resetSessionState: (
    signal: AbortSignal,
    options?: { readonly truncate?: boolean },
  ) => Promise<void>;
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
  /**
   * MCP server status — returns configured servers, their connection states,
   * and tool counts. Used by the `/mcp` TUI command. Returns empty array when
   * no MCP servers are configured.
   */
  readonly getMcpStatus: () => Promise<readonly McpServerStatus[]>;
  /**
   * Plugin discovery summary — loaded plugins + any errors.
   * Static for the lifetime of the runtime. Used by the TUI to populate
   * the /plugins view and inject plugin awareness into the system prompt.
   */
  readonly pluginSummary: PluginDiscoverySummary;
}

/** Status entry for a single MCP server (used by /mcp TUI command). */
export interface McpServerStatus {
  readonly name: string;
  readonly toolCount: number;
  readonly failureCode: string | undefined;
  readonly failureMessage: string | undefined;
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
 *
 * **IMPORTANT — default behavior for optional fields (read before
 * calling this from a new host):**
 *
 * - `loopDetection` — when omitted, the engine's default detector is
 *   enabled. This is a semantic change from the pre-refactor behavior
 *   where the factory hard-disabled loop detection unconditionally.
 *   Hosts that rely on detection being OFF (e.g. `koi tui` where
 *   interactive false-positives are expensive) MUST pass
 *   `loopDetection: false` explicitly.
 * - `backgroundSubprocesses` — when omitted, defaults to `true`
 *   (execution stack contributes the `bash_background` tool). Hosts
 *   that want a narrower tool surface (e.g. `koi start` with auto-
 *   allow permissions) MUST pass `backgroundSubprocesses: false`
 *   explicitly. The `task_*` tool set stays wired regardless.
 *
 * Both known call sites (`koi start` in `commands/start.ts` and
 * `koi tui` in `tui-command.ts`) pass explicit values for these two
 * fields. The test harness in `runtime-factory.test.ts` exercises
 * the factory via mock adapters and does not rely on the defaults.
 * If you add a new caller, pass both fields explicitly and document
 * the chosen posture.
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
  const pluginComponents = await loadPluginComponents(
    pluginUserRoot,
    config.plugins !== undefined ? { allowlist: new Set(config.plugins) } : undefined,
  );
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

  // Surface skipped middleware as a warning in the plugin summary so
  // /plugins shows it, but don't block the plugin's other components.
  const middlewareWarnings =
    pluginComponents.middlewareNames.length > 0
      ? [
          {
            plugin: "(middleware)",
            error: `Skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
          },
        ]
      : [];
  const pluginSummary: PluginDiscoverySummary = {
    loaded: pluginComponents.discovered,
    errors: [...pluginComponents.errors, ...middlewareWarnings],
  };
  if (pluginSummary.loaded.length > 0) {
    // Sanitize plugin-derived strings before logging to prevent terminal
    // control sequence injection from malicious plugin manifests.
    const ANSI_LOG_RE = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
    const CTRL_LOG_RE = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
    const sanitizeLog = (s: string): string => s.replace(ANSI_LOG_RE, "").replace(CTRL_LOG_RE, "");
    const names = pluginSummary.loaded
      .map((p) => `${sanitizeLog(p.name)}@${sanitizeLog(p.version)}`)
      .join(", ");
    console.error(
      `[koi/${hostId}] ${String(pluginSummary.loaded.length)} plugin(s) loaded: ${names}`,
    );
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
  // Determine whether the spawn preset stack is in the active set
  // for this host. When no explicit `config.stacks` list was given,
  // the factory activates every stack in `DEFAULT_STACKS` — so
  // spawn is on by default. When an explicit list IS given (e.g.
  // `koi start` passes `DEFAULT_STACKS_WITHOUT_SPAWN`), we check
  // for membership directly. The derived flag flows through into
  // the execution stack so task_* tools get wired IFF spawn is
  // active (coordinator surface is consistent with sub-agent
  // capability).
  const spawnStackActive = enabledStackIds === undefined || enabledStackIds.has("spawn");

  // Zone B + spawn used to be a fail-closed combination because
  // children would otherwise have shared the parent's mutable
  // middleware instances (audit queues, hash chains, session
  // lifecycle state). The spawn preset stack now accepts a
  // `perChildMiddlewareFactory` that re-resolves manifest
  // middleware fresh per child, so children get their own
  // per-session state without escaping manifest-enforced policy.
  // The factory itself is built and stashed below, after the
  // manifest registry is constructed.

  // `bash_background` depends on the task-board surface for job
  // status / output inspection. If the caller requested
  // `backgroundSubprocesses: true` but the spawn stack (which
  // gates task_*) is excluded, we have an incoherent
  // combination: the model could launch detached work but have
  // no supported way to read its output or detect completion.
  // Force-override to `false` and warn the operator so the
  // runtime assembles cleanly instead of booting into a broken
  // state. `koi start` rejects this combo earlier at manifest
  // validation, so only TUI manifests with a custom `stacks`
  // list hit this branch.
  const rawBackgroundSubprocesses = config.backgroundSubprocesses ?? true;
  const effectiveBackgroundSubprocesses = rawBackgroundSubprocesses && spawnStackActive;
  if (rawBackgroundSubprocesses && !spawnStackActive) {
    console.warn(
      `[koi/${hostId}] backgroundSubprocesses=true requires the spawn preset stack ` +
        "(for task_create / task_output / task_stop observability). spawn is not in " +
        "the active stack set — bash_background is being disabled automatically. " +
        "Either add 'spawn' to manifest.stacks or explicitly set " +
        "backgroundSubprocesses: false to silence this warning.",
    );
  }

  const earlyContextHost: Record<string, unknown> = {
    ...(skillsRuntime !== undefined ? { skillsRuntime } : {}),
    ...(config.otel !== undefined ? { otelConfig: config.otel } : {}),
    approvalHandler,
    agentId: precomputedAgentId,
    modelName,
    pluginMcpServers: pluginComponents.mcpServers,
    // Effective flag: caller-requested AND spawn stack active. The
    // invariant is "bash_background requires the task-board
    // surface" and the factory enforces it here rather than
    // letting the execution stack assemble an unmanageable
    // background-job surface.
    backgroundSubprocesses: effectiveBackgroundSubprocesses,
    // Task-board tool surface tracks spawn-stack enablement: with
    // spawn active, coordinator flows need task_* wired; without,
    // the task surface is vestigial and would only create
    // detector false-positive exposure.
    taskBoardTools: spawnStackActive,
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
    onLoadError: (message) => {
      // Per-entry loader errors: surface each so operators see which entry
      // broke the file instead of silently losing every hook (issue #1781).
      console.warn(`[koi tui] hooks.json: ${message}`);
    },
  });
  // Merge plugin hooks (session tier) with user hooks (user tier).
  // Plugin hooks run first within their tier; user hooks in the next tier phase.
  const allHooks = mergeUserAndPluginHooks(loadedHooks, pluginComponents.hooks, {
    filterAgentHooks: true,
    onFilteredAgentHooks: (names) => {
      console.warn(
        `[koi tui] ${names.length} plugin agent hook(s) skipped (not supported in TUI): ${names.join(", ")}`,
      );
    },
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
  // fs_read path rules: workspace paths are auto-allowed, out-of-workspace
  // paths trigger an "ask" prompt. The permission middleware injects
  // context.path via resolveToolPath, and the rule evaluator matches
  // glob patterns on it. Rules evaluated in order — first match wins.
  const tuiAllowRules: readonly SourcedRule[] = [
    { pattern: "Glob", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "Grep", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "ToolSearch", action: "invoke", effect: "allow", source: "policy" },
    {
      pattern: "fs_read",
      action: "invoke",
      effect: "allow",
      source: "policy",
      context: { path: `${cwd}/**` },
    },
    {
      pattern: "fs_read",
      action: "invoke",
      effect: "ask",
      source: "policy",
      reason: "File is outside the workspace — approve to read",
    },
    { pattern: "task_get", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_list", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_output", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_create", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_update", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "task_stop", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "Skill", action: "invoke", effect: "allow", source: "policy" },
    // Memory tools — sandboxed to .koi/memory/, own state, not workspace files
    { pattern: "memory_store", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "memory_recall", action: "invoke", effect: "allow", source: "policy" },
    { pattern: "memory_search", action: "invoke", effect: "allow", source: "policy" },
    // memory_delete intentionally NOT auto-allowed — deletes durable on-disk state
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
  const FS_PATH_TOOLS: ReadonlySet<string> = new Set(["fs_read", "fs_write", "fs_edit"]);

  const permMw = createPermissionsMiddleware({
    backend: permBackend,
    description: config.permissionsDescription ?? "koi tui — default permission mode",
    resolveToolPath: (
      toolId: string,
      input: import("@koi/core").JsonObject,
    ): string | undefined => {
      if (!FS_PATH_TOOLS.has(toolId)) return undefined;
      const raw = input.path;
      if (typeof raw !== "string") return undefined;
      return resolveFsPath(raw, cwd);
    },
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
    ...(config.filesystemOperations !== undefined
      ? { filesystemOperations: config.filesystemOperations }
      : {}),
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

  // --- Zone B: resolve manifest-declared middleware ---
  // Resolved BEFORE late-phase stack activation and BEFORE the
  // child-inheritance snapshot below, so that:
  //   (1) spawned child agents inherit the same manifest-declared
  //       middleware as the parent — preventing a split-brain where
  //       delegated work silently escapes manifest policy.
  //   (2) resolved entries can read early-phase stack exports
  //       (bashHandle, trajectoryStore, ...) via
  //       `ManifestMiddlewareContext.stackExports`.
  //
  // Unknown names throw with the full registered-name list. Core
  // middleware names are rejected by the manifest loader earlier
  // and cannot reach this code path. The composed chain wraps
  // zone B from outside with `hook`/`permissions`/`exfiltration-
  // guard` so repo-authored content only sees already-gated,
  // already-redacted traffic (see `compose-middleware.ts`).
  //
  // (The manifest+spawn incompatibility check runs earlier —
  // BEFORE activateStacks — so a rejected config cannot mutate
  // disk through checkpoint/MCP/etc. stack activation before the
  // error surfaces.)
  const manifestMiddlewareRegistry =
    config.middlewareRegistry ??
    createBuiltinManifestRegistry({
      allowFileBackedSinks: config.allowManifestFileSinks === true,
    });
  // workingDirectory is threaded from `config.cwd` (same source as
  // file tools and permission scope) rather than `process.cwd()`, so
  // embedders that build runtimes for workspaces other than the
  // launcher process directory get consistent path resolution across
  // audit sinks, fs_read permissions, and Bash tool working dir.
  const zoneBWorkingDirectory = config.cwd ?? process.cwd();
  // Cleanup callbacks registered by file-backed manifest middleware
  // factories (currently only @koi/middleware-audit, which opens an
  // NDJSON writer at resolution time). Fired from runtime.dispose()
  // on the returned handle in the success path, and from the
  // assembly-failure unwind below when any step between resolution
  // and the return throws.
  const manifestMiddlewareShutdownHooks: Array<() => Promise<void> | void> = [];
  // Unwind helper: fires registered cleanup callbacks in reverse
  // order, swallowing individual errors. Used by the post-resolution
  // assembly-failure path (see the top-level try/catch below).
  const unwindManifestMiddlewareHooks = async (): Promise<void> => {
    for (const hook of [...manifestMiddlewareShutdownHooks].reverse()) {
      try {
        await hook();
      } catch (cleanupErr) {
        console.warn(
          `[koi/${hostId}] manifest-middleware cleanup failed during error unwind: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
  };
  // Track whether ownership of manifest resources has been
  // transferred to the returned runtime handle. Set to `true`
  // immediately before `return` below. If any error escapes the
  // assembly between here and the return, the outer catch at the
  // end of the function invokes `unwindManifestMiddlewareHooks` to
  // release file descriptors / flush timers before rethrowing.
  // `let` is justified because the flag is mutated at the success
  // exit point.
  let handleOwnershipTransferred = false;
  // Runtime-wide shared sink cache for file-backed manifest
  // middleware. Parent resolve + every per-child re-resolution
  // share this map so a single NDJSON writer serves one canonical
  // filePath regardless of how many spawns run. See the block
  // comment on `ManifestMiddlewareContext.sharedAuditSinks` for
  // why independent writers per child would corrupt the trail.
  const sharedAuditSinks: ManifestMiddlewareContext["sharedAuditSinks"] = new Map();
  // Parent-scoped accumulator for failures that happen during
  // per-child manifest cleanup (audit sink close, release hook
  // throws, etc). drainHooks() in the per-child factory appends
  // here instead of only logging, and wrappedDispose surfaces
  // any accumulated entries as part of its AggregateError on the
  // next parent-visible dispose — guaranteeing host observability
  // even when children outlive the parent's first dispose call.
  const childManifestCleanupFailures: unknown[] = [];
  let zoneBMiddleware: readonly KoiMiddleware[];
  try {
    zoneBMiddleware = await resolveManifestMiddleware(
      config.manifestMiddleware,
      manifestMiddlewareRegistry,
      {
        sessionId: config.session?.sessionId ?? "no-session",
        hostId,
        workingDirectory: zoneBWorkingDirectory,
        stackExports: earlyContribution.exports,
        registerShutdown: (fn) => {
          manifestMiddlewareShutdownHooks.push(fn);
        },
        sharedAuditSinks,
      },
    );
  } catch (err) {
    // Resolution itself threw (unknown-name, blocklist, audit path
    // validation, etc.). Unwind any partially-constructed resources
    // from factories that registered before the failure, then
    // rethrow.
    await unwindManifestMiddlewareHooks();
    throw err;
  }

  // Post-resolution assembly is wrapped so any subsequent failure
  // (late-phase stack activation, middleware composition, tracing
  // setup, createKoi, session rotation wiring, etc.) unwinds the
  // manifest resources that were opened at resolution time. Without
  // this, an error after resolve would leak the NDJSON writer +
  // flush timer of an open audit sink for the life of the process.
  try {
    // --- Late-phase stack activation (spawn + any future late stacks) ---
    // Now that the core middleware and zone B are both built, publish
    // the child-inheritance list into the late context's `host` bag
    // and fire the late pass. Spawn reads
    // `LATE_PHASE_HOST_KEYS.inheritedMiddleware` and composes its
    // child adapter around it.
    //
    // Zone B is INTENTIONALLY NOT inherited — see
    // `buildInheritedMiddlewareForChildren` for the rationale. Sharing
    // parent middleware instances with children would interleave
    // mutable per-session state (e.g. audit queues + hash chains).
    //
    // (The spawn+zoneB incompatibility check runs earlier, BEFORE
    // manifest middleware is resolved, so that a rejected config
    // cannot cause any factory to open files or allocate resources.)
    const inheritedMiddlewareForChildren = buildInheritedMiddlewareForChildren({
      permissions: permMw,
      exfiltrationGuard: exfiltrationGuardMw,
      hook: hookMw,
      ...(systemPromptMw !== undefined ? { systemPrompt: systemPromptMw } : {}),
    });
    // Build the per-child manifest-middleware factory. Each call
    // re-runs `resolveManifestMiddleware` with a fresh context so
    // the child gets its own middleware instances (own audit
    // queue, own lifecycle hooks) rather than sharing the parent's
    // mutable state. The child context's sessionId includes a
    // unique per-spawn `childRunId` so sibling children never
    // collapse onto one derived identifier.
    //
    // The shared-sink cache (created above, captured in closure)
    // is passed to every per-child resolve too. File-backed
    // middleware (audit) checks the cache and reuses the parent's
    // already-open writer instead of opening a new one per child.
    // One writer per canonical file → no interleaved independent
    // writers → no corrupted hash chains. Each child still gets
    // its own middleware instance (own queue, own lifecycle
    // hooks) routed through the shared sink.
    //
    // Cleanup callbacks: only the FIRST resolver to open a sink
    // registers the close hook. Per-child resolutions that reuse
    // the cached sink do NOT re-register close, so the dispose
    // chain closes each sink exactly once.
    const buildPerChildManifestMiddlewareFactory = ():
      | ((childCtx: {
          readonly childRunId: string;
          readonly parentAgentId: string;
          readonly childAgentId: string;
          readonly childAgentName: string;
        }) => Promise<{
          readonly middleware: readonly KoiMiddleware[];
          readonly unwind?: () => Promise<void> | void;
        }>)
      | undefined => {
      if ((config.manifestMiddleware ?? []).length === 0) {
        return undefined;
      }
      return async (childCtx) => {
        // Read the LIVE parent runtime session id, not a static
        // manifest label. `runtimeForRotation` is the mutable
        // reference the factory populates once the engine runtime
        // is constructed; it rotates on cycleSession() and rebinds
        // on resume. Reading it here means children spawned after
        // a /clear or /rewind correctly inherit the rotated parent
        // session id as their prefix. Fall back to a neutral label
        // on the (normally unreachable) pre-assignment path.
        const liveParentSessionId = runtimeForRotation?.sessionId ?? "parent-session";
        // Per-child registerShutdown collects hooks into a local
        // array that is invoked via a synthetic cleanup middleware
        // on the child's `onSessionEnd`. This gives third-party
        // factories a real per-child cleanup channel without ever
        // touching the parent runtime's shutdown array — so cleanup
        // fires exactly at child-session boundary and never
        // accumulates one-per-spawn on long-lived parents.
        //
        // Built-ins (@koi/middleware-audit) hit the sharedAuditSinks
        // cache and skip registerShutdown entirely on the per-child
        // path, so this channel stays empty for them and no synthetic
        // middleware is appended.
        const perChildShutdownHooks: Array<() => Promise<void> | void> = [];
        // Per-hook completion tracking mirrors the parent dispose
        // path: a transient failure on one hook (e.g. flaky audit
        // flush) must stay retryable on the next drainHooks call,
        // while already-successful hooks stay latched and do not
        // re-run. A single `drained` flag would either drop the
        // failed hook forever or re-run already-successful hooks
        // and risk double-close.
        const completedChildHooks = new WeakSet<() => Promise<void> | void>();
        const drainHooks = async (): Promise<void> => {
          // Reverse order so later registrations unwind first,
          // matching the parent's registerShutdown semantics.
          // Collect every hook failure: push onto the parent-
          // scoped accumulator so wrappedDispose can surface it
          // on the next parent-visible lifecycle operation, AND
          // throw an AggregateError so the immediate caller
          // (onSessionEnd / unwind) sees the failure too.
          const errors: unknown[] = [];
          for (const hook of [...perChildShutdownHooks].reverse()) {
            if (completedChildHooks.has(hook)) continue;
            try {
              await hook();
              completedChildHooks.add(hook);
            } catch (err) {
              errors.push(err);
              childManifestCleanupFailures.push(err);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              `per-child manifest cleanup had ${errors.length} failure(s) at child session end. ` +
                "Audit sinks or other file-backed child cleanup may not have fully flushed — " +
                "the failures have also been attached to the parent runtime's dispose chain so the " +
                "host's shutdown-reporting path will observe them. A subsequent drain (e.g. retry " +
                "from wrappedDispose) will retry only the hooks that failed.",
            );
          }
        };
        let childMiddleware: readonly KoiMiddleware[];
        try {
          childMiddleware = await resolveManifestMiddleware(
            config.manifestMiddleware,
            manifestMiddlewareRegistry,
            {
              // Label the child session by the CHILD agent id +
              // runId, not the parent agent id. Operators
              // correlating a child audit stream back to the
              // spawned agent need the child identity in the
              // prefix; parentAgentId is retained in
              // `parent:` so the lineage is still recoverable.
              sessionId: `${liveParentSessionId}/parent:${childCtx.parentAgentId}/child:${childCtx.childAgentName}:${childCtx.childAgentId}:${childCtx.childRunId}`,
              hostId,
              workingDirectory: zoneBWorkingDirectory,
              // Child re-resolution inherits the parent's stack
              // exports. This keeps the parent and spawned
              // children on the same manifest-middleware policy:
              // any factory that legitimately reads a parent-
              // exported handle (bashHandle, trajectory store,
              // checkpoint, ...) keeps working on the child
              // path instead of silently degrading when
              // delegated. The Readonly<Record<string, unknown>>
              // shape advertised by ManifestMiddlewareContext
              // remains the contract: factories must treat
              // inherited handles as read-only and never mutate
              // parent-scoped state. A child runtime that needs
              // its own early-phase exports must run through a
              // full independent runtime-factory assembly — out
              // of scope for per-child manifest re-resolution.
              stackExports: earlyContribution.exports,
              registerShutdown: (fn) => {
                perChildShutdownHooks.push(fn);
              },
              sharedAuditSinks,
            },
          );
        } catch (resolveErr) {
          // Factory partially allocated resources before throwing.
          // Drain whatever has been registered so nothing leaks,
          // then re-throw so the engine converts it to a
          // SpawnResult.error.
          await drainHooks();
          throw resolveErr;
        }
        if (perChildShutdownHooks.length === 0) {
          return { middleware: childMiddleware };
        }
        // Append a synthetic cleanup middleware that drains the
        // collected hooks at child session end. Observe-phase +
        // low priority so it runs after every real middleware's
        // own onSessionEnd. drainHooks() is idempotent: whichever
        // path fires first (normal completion via onSessionEnd
        // OR post-resolution failure via `unwind`) wins, and the
        // other becomes a no-op.
        const cleanupMiddleware: KoiMiddleware = {
          name: "per-child-cleanup",
          phase: "observe",
          priority: 999,
          concurrent: true,
          describeCapabilities: () => undefined,
          onSessionEnd: async () => {
            await drainHooks();
          },
        };
        return {
          middleware: [...childMiddleware, cleanupMiddleware],
          unwind: drainHooks,
        };
      };
    };
    const perChildManifestMiddlewareFactory = buildPerChildManifestMiddlewareFactory();
    const lateContext: import("./preset-stacks.js").StackActivationContext = {
      ...earlyContext,
      host: {
        ...earlyContextHost,
        [LATE_PHASE_HOST_KEYS.inheritedMiddleware]: inheritedMiddlewareForChildren,
        ...(perChildManifestMiddlewareFactory !== undefined
          ? {
              [LATE_PHASE_HOST_KEYS.perChildManifestMiddlewareFactory]:
                perChildManifestMiddlewareFactory,
            }
          : {}),
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

    // --- MCP resolvers exported by the MCP preset stack ---
    // Read here for the returned KoiRuntimeHandle.getMcpStatus().
    const mcpResolver = stackContribution.exports.mcpResolver as
      | import("@koi/mcp").McpResolver
      | undefined;
    const mcpPluginResolver = stackContribution.exports.mcpPluginResolver as
      | import("@koi/mcp").McpResolver
      | undefined;

    // --- Audit middleware (opt-in via config.auditNdjsonPath) ---
    // Build the NDJSON sink + hash-chained audit middleware when the host
    // host opted in (KOI_AUDIT_NDJSON env var in the TUI). The runtime
    // owns both the middleware and the underlying sink's writer/timer;
    // `shutdownBackgroundTasks` below flushes and closes on shutdown.
    // let: retained so shutdown can flush+close.
    let auditMwForShutdown:
      | { readonly flush: () => Promise<void>; readonly close: () => Promise<void> }
      | undefined;
    const auditPresetExtras: KoiMiddleware[] = [];
    if (config.auditNdjsonPath !== undefined) {
      // Collision guard: refuse to start if the legacy host-level
      // audit path (env-driven KOI_AUDIT_NDJSON / config.auditNdjsonPath)
      // points at the same canonical file as any enabled
      // `@koi/middleware-audit` manifest entry. Two independent
      // writers against the same NDJSON file would interleave
      // records, corrupt the hash/signing chain, and break the
      // integrity story that the manifest audit path is trying
      // to harden. Hosts that want both paths active must target
      // different files.
      const legacyCanonical = canonicalizeAuditSinkPath(
        config.auditNdjsonPath,
        zoneBWorkingDirectory,
      );
      if (legacyCanonical !== undefined && config.manifestMiddleware !== undefined) {
        for (const entry of config.manifestMiddleware) {
          if (entry.enabled === false || entry.name !== "@koi/middleware-audit") continue;
          const entryPath = entry.options?.filePath;
          if (typeof entryPath !== "string" || entryPath.length === 0) continue;
          const entryCanonical = canonicalizeAuditSinkPath(entryPath, zoneBWorkingDirectory);
          if (entryCanonical === legacyCanonical) {
            throw new Error(
              `audit sink collision: host-level auditNdjsonPath "${config.auditNdjsonPath}" ` +
                `resolves to the same canonical path as manifest @koi/middleware-audit entry "${entryPath}". ` +
                "Two independent writers cannot share the same NDJSON file — they would interleave " +
                "records and corrupt the hash/signing chain. Point one path at a different file, or " +
                "disable one of the audit surfaces.",
            );
          }
        }
      }
      const auditSink = createNdjsonAuditSink({ filePath: config.auditNdjsonPath });
      const auditMw = createAuditMiddleware({ sink: auditSink });
      auditPresetExtras.push(auditMw);
      auditMwForShutdown = {
        flush: () => auditMw.flush(),
        close: () => auditSink.close(),
      };
    }

    // --- Compose middleware via the standalone `composeRuntimeMiddleware` ---
    // The ordering (outermost → innermost) is defined in one place —
    // compose-middleware.ts. Preset stacks (observability, checkpoint,
    // memory, execution, etc.) plug in via `presetExtras`; user-
    // controlled manifest middleware plugs in via `manifestMiddleware`;
    // the named slots here are the ALWAYS-ON core layers only.
    const allMiddleware = composeRuntimeMiddleware({
      hook: hookMw,
      permissions: permMw,
      exfiltrationGuard: exfiltrationGuardMw,
      ...(config.modelRouterMiddleware !== undefined
        ? { modelRouter: config.modelRouterMiddleware }
        : {}),
      ...(goalMw !== undefined ? { goal: goalMw } : {}),
      // presetExtras includes both the code-owned stack middleware
      // and main's env-var-gated audit preset extras (from
      // `auditNdjsonPath` / `KOI_AUDIT_NDJSON`), kept for backward
      // compatibility with that host opt-in. Zone B manifest
      // middleware flows through the separate `manifestMiddleware`
      // slot and is composed strictly INSIDE the security core
      // layers, regardless of array position here.
      presetExtras: [...stackContribution.middleware, ...auditPresetExtras],
      manifestMiddleware: zoneBMiddleware,
      ...(systemPromptMw !== undefined ? { systemPrompt: systemPromptMw } : {}),
      ...(sessionTranscriptMw !== undefined ? { sessionTranscript: sessionTranscriptMw } : {}),
    });

    // --- Required-set invariant: refuse to boot with a gutted chain ---
    // Runs after composition so it checks the actually-assembled list,
    // not the intended inputs. This is the last line of defense
    // against a programmatic caller that constructs a chain without
    // the core security layers. Terminal-capable runtimes (koi tui,
    // koi start) always require hooks + permissions +
    // exfiltration-guard. See `required-middleware.ts`.
    enforceRequiredMiddleware(allMiddleware, {
      terminalCapable: config.terminalCapable ?? true,
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
    //
    // Also pass `rotateSessionId` so `cycleSession()` (fired by
    // `resetSessionState` on `/clear`/`/new`) preserves the host's
    // id format. Without this, the engine would mint a default
    // `agent:{agentId}:{uuid}` on every rotation — the host-owned
    // JSONL file name, post-quit resume hint, and everything else
    // keyed off the stable id would silently diverge from where the
    // session-transcript middleware actually writes subsequent
    // turns (see `session-transcript.ts` — routing reads
    // `ctx.session.sessionId`, which is the engine's rotated id).
    // The rotation callback reads from a mutable ref that tracks
    // the LIVE session id rather than capturing the construction-
    // time `sess.sessionId` value. Hosts may call
    // `runtime.rebindSessionId(...)` between construction and a
    // later `cycleSession()` (e.g. `koi tui` rebinds after a
    // successful `/rewind` so future writes land on the rewound
    // session). With a snapshotted callback, the next `/clear`
    // would snap the engine back to the original startup id —
    // checkpoint reset would prune the wrong chain and the live
    // session's pre-clear snapshots would survive the boundary.
    // The runtime ref is assigned immediately after `createKoi`
    // returns; the engine never invokes `rotateSessionId` during
    // construction, only during a later `cycleSession()`, so the
    // ref is always populated by the time the callback fires.
    // let justified: assigned on the line below
    let runtimeForRotation: import("@koi/engine").KoiRuntime | undefined;
    const runtime = await createKoi({
      manifest: { name: "koi-tui", version: "0.1.0", model: { name: modelName } },
      adapter: engineAdapter,
      middleware: tracedMiddleware,
      ...(():
        | { sessionId: SessionId; rotateSessionId: () => SessionId }
        | Record<string, never> => {
        const sess = config.session;
        if (sess === undefined) return {};
        return {
          sessionId: sess.sessionId,
          rotateSessionId: (): SessionId => {
            // Read from the live runtime so a prior `rebindSessionId`
            // is honored. If somehow the callback fires before the
            // assignment below (it shouldn't — the engine only calls
            // it from `cycleSession()`, which can't run during
            // construction), fall back to the construction id.
            const liveId = runtimeForRotation?.sessionId;
            return (liveId ?? sess.sessionId) as SessionId;
          },
        };
      })(),
      providers: [...coreProviders, ...stackContribution.providers],
      approvalHandler,
      userId: userInfo().username,
      // Loop detection defaults to ENABLED (createKoi's default).
      // Callers explicitly opt out: `koi tui` passes `false` because its
      // per-submit iteration budget reset + governance caps already
      // bound spirals, and the interactive surface makes false
      // positives expensive. `koi start` omits this field so the
      // default stays on — the auto-allow permission backend means a
      // bad iteration would otherwise hammer tools until the broader
      // caps trip, which is exactly what the detector exists to
      // prevent.
      ...(config.loopDetection !== undefined ? { loopDetection: config.loopDetection } : {}),
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
    // Hand the live runtime to the rotation closure above. The
    // engine never invokes `rotateSessionId` during construction
    // (only from a later `cycleSession()`), so this assignment
    // happens before any rotation can fire.
    runtimeForRotation = runtime;

    // Wrap runtime.dispose so manifest-middleware cleanup (audit sink
    // close, etc.) runs AFTER the engine's dispose path completes.
    // Engine dispose triggers middleware onSessionEnd hooks, which is
    // when audit writes its final `session_end` record. Closing the
    // sink before dispose would drop that record. We also remove the
    // cleanup from shutdownBackgroundTasks below so it is only wired
    // through this one authoritative path.
    //
    // IMPORTANT: cleanup runs ONLY if `engineDispose()` resolves
    // successfully. The engine's poisoned-runtime contract says that
    // when dispose throws or times out, onSessionEnd/adapter teardown
    // was skipped and in-flight middleware state is still live. The
    // caller is expected to SIGKILL the wedged tool and retry dispose
    // later. Closing manifest resources here would:
    //   1. Prevent the retry dispose from emitting the final
    //      session_end audit record (writer/timer already torn down).
    //   2. Race with any still-running middleware that has not had
    //      onSessionEnd called.
    // On dispose failure we therefore leave manifest hooks registered
    // so a subsequent successful retry can still fire them.
    //
    // The wrapper uses a Proxy so live getters on the underlying
    // runtime (notably `sessionId`, which is a getter that changes
    // after `cycleSession()` or `rebindSessionId()`) are forwarded
    // through `Reflect.get` instead of being snapshotted by
    // object-spread. An object-spread wrapper would copy the value
    // of the sessionId getter at construction time and freeze it,
    // breaking every post-reset/rebind caller that later reads
    // `runtimeHandle.runtime.sessionId` to locate transcript or
    // checkpoint state for the current session.
    const engineDispose = runtime.dispose.bind(runtime);
    // Latch: manifest cleanup runs at most once across repeated
    // dispose() calls. The engine's own dispose() is a documented
    // no-op on second call; the wrapped dispose must preserve that
    // contract, otherwise retry/idempotent shutdown paths would
    // re-call `sink.close()` on an already-ended writer and throw.
    //
    // Tracking is per-hook rather than a single global flag: a
    // transient failure on one hook (e.g. a flaky audit flush)
    // must be retryable on the next dispose() while already-
    // successful hooks stay latched and do not re-run. A single
    // global flag would either:
    //   - mark cleanup done on any partial completion, silently
    //     dropping the failed hook forever (data loss), or
    //   - leave cleanup unmarked, re-running ALL hooks (including
    //     successful ones) and risking double-close on the
    //     already-ended writers.
    // Per-hook tracking gives precise retry semantics.
    const completedManifestHooks = new WeakSet<() => Promise<void> | void>();
    const wrappedDispose = async (): Promise<void> => {
      await engineDispose();
      // Fire manifest-middleware cleanup in reverse registration
      // order, skipping hooks that already ran successfully. Each
      // surviving hook is awaited so audit sinks' final flush +
      // writer.end() complete before dispose resolves.
      //
      // Cleanup failures are aggregated into a single error and
      // thrown after every unfinished hook has been attempted.
      // Audit and similar file-backed middleware treat finalization
      // as a correctness/security property: silently downgrading a
      // failed flush to a successful shutdown would let buffered
      // records never hit disk while the host reports success.
      // Hooks that succeed mid-pass are marked complete BEFORE the
      // throw so a retry dispose() re-runs only the ones that
      // failed.
      const hookErrors: unknown[] = [];
      for (const hook of [...manifestMiddlewareShutdownHooks].reverse()) {
        if (completedManifestHooks.has(hook)) {
          continue;
        }
        try {
          await hook();
          completedManifestHooks.add(hook);
        } catch (hookErr) {
          console.warn(
            `[koi/${hostId}] manifest-middleware shutdown hook failed during dispose: ${
              hookErr instanceof Error ? hookErr.message : String(hookErr)
            }`,
          );
          hookErrors.push(hookErr);
        }
      }
      // Drain any deferred per-child cleanup failures accumulated
      // while children were still running after a prior parent
      // dispose call. Each call to wrappedDispose resets the
      // accumulator so the same errors aren't surfaced twice on
      // repeated dispose attempts.
      const pendingChildErrors = childManifestCleanupFailures.splice(0);
      hookErrors.push(...pendingChildErrors);
      if (hookErrors.length > 0) {
        throw new AggregateError(
          hookErrors,
          `manifest-middleware shutdown had ${hookErrors.length} failure(s) during runtime.dispose ` +
            `(${pendingChildErrors.length} from per-child cleanup). Audit sinks or other file-backed cleanup may not have ` +
            "fully flushed — treat shutdown as failed and surface this error to the host's shutdown-reporting path. " +
            "A subsequent runtime.dispose() call will retry the failed parent hooks without re-running the ones that " +
            "already completed.",
        );
      }
    };
    const wrappedRuntime: typeof runtime = new Proxy(runtime, {
      get(target, prop, receiver): unknown {
        if (prop === "dispose") return wrappedDispose;
        return Reflect.get(target, prop, receiver);
      },
    });

    // Handle is about to be constructed and returned. Flip the flag
    // so the outer catch below treats a successful return as "ownership
    // transferred" and does NOT fire unwindManifestMiddlewareHooks.
    handleOwnershipTransferred = true;
    return {
      runtime: wrappedRuntime,
      checkpoint: checkpointHandle,
      transcript,
      sandboxActive,
      pluginSummary,
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
      getMcpStatus: async (): Promise<readonly McpServerStatus[]> => {
        // Merge user + plugin MCP resolvers — key by (source, name)
        // so duplicate names from different sources surface as
        // separate rows instead of hiding failures behind successes.
        const sources: {
          readonly label: string;
          readonly resolver: import("@koi/mcp").McpResolver;
        }[] = [];
        if (mcpResolver !== undefined) sources.push({ label: "user", resolver: mcpResolver });
        if (mcpPluginResolver !== undefined)
          sources.push({ label: "plugin", resolver: mcpPluginResolver });
        if (sources.length === 0) return [];

        const entries: McpServerStatus[] = [];
        const seenByKey = new Set<string>();
        for (const { label, resolver } of sources) {
          const toolCounts = new Map<string, number>();
          const descriptors = await resolver.discover();
          for (const d of descriptors) {
            const server = d.server ?? "unknown";
            toolCounts.set(server, (toolCounts.get(server) ?? 0) + 1);
          }
          for (const [name, count] of toolCounts) {
            const displayName = sources.length > 1 ? `${label}:${name}` : name;
            const key = `${label}:${name}`;
            if (seenByKey.has(key)) continue;
            seenByKey.add(key);
            entries.push({
              name: displayName,
              toolCount: count,
              failureCode: undefined,
              failureMessage: undefined,
            });
          }
          for (const f of resolver.failures) {
            if (toolCounts.has(f.serverName)) continue;
            const displayName = sources.length > 1 ? `${label}:${f.serverName}` : f.serverName;
            const key = `${label}:${f.serverName}`;
            if (seenByKey.has(key)) continue;
            seenByKey.add(key);
            entries.push({
              name: displayName,
              toolCount: 0,
              failureCode: f.error.code,
              failureMessage: f.error.message,
            });
          }
        }
        return entries;
      },
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
      resetSessionState: async (signal: AbortSignal, options?: { readonly truncate?: boolean }) => {
        // `truncate` signals the host's intent: `true` for destructive
        // boundaries like `/clear` or `/new` that wipe persisted state,
        // `false` (or omitted) for non-destructive resets like a picker
        // session switch or a post-rewind in-memory rebuild. Stacks
        // that hold per-session durable state (checkpoint chains)
        // gate destructive cleanup on this flag — pruning the chain
        // on a picker load or a successful rewind would silently
        // erase history the user explicitly opted to keep.
        const truncate = options?.truncate === true;
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
        //    ordered.
        //
        //    Collect errors from each hook instead of swallowing them.
        //    Every sibling still gets a chance to run (one wedged stack
        //    must not block the others) but a non-empty error list makes
        //    this function fail closed — the host catches the throw,
        //    flags the reset as unpersisted, and suppresses downstream
        //    affordances like the post-quit resume hint. Load-bearing
        //    for stacks whose state carries cross-boundary invariants:
        //    e.g. the checkpoint stack prunes the on-disk chain so
        //    `/rewind` after quit+resume cannot walk back into pre-
        //    clear snapshots; a swallowed prune failure would report
        //    `/clear` as successful while leaving the snapshots intact.
        //
        //    `resetContext.sessionId` is the LIVE runtime session id
        //    read at hook-call time. Callers may have invoked
        //    `runtime.rebindSessionId` between stack activation and
        //    reset (e.g. `koi tui` rebinds after `/rewind`), so a
        //    snapshot captured during activation is not safe here.
        const resetContext = {
          sessionId: runtime.sessionId as SessionId,
          truncate,
        } as const;
        const hookErrors: unknown[] = [];
        for (const hook of stackContribution.resetSessionHooks) {
          try {
            await hook(signal, resetContext);
          } catch (hookErr) {
            console.warn(
              `[koi/${hostId}] preset stack onResetSession hook failed: ${
                hookErr instanceof Error ? hookErr.message : String(hookErr)
              }`,
            );
            hookErrors.push(hookErr);
          }
        }

        // 3. Clear the OLD session's approval state (always-allow, caches,
        //    trackers). Not a stack concern — permissions is a core slot.
        //    Always runs even if a hook failed — approval state is cheap
        //    to clear and leaving it stale after a partial reset would
        //    leak cross-session grants.
        permMw.clearSessionApprovals(priorSessionId);

        // 4. If any hook failed, fail closed. `AggregateError` is the
        //    standard JS primitive for "multiple errors from sibling
        //    operations". The host's reset barrier catches this and
        //    flips `clearPersistFailed` so the post-quit resume hint
        //    is suppressed / the UI surfaces "reset may be incomplete".
        if (hookErrors.length > 0) {
          throw new AggregateError(
            hookErrors,
            `resetSessionState: ${hookErrors.length} preset stack reset hook(s) failed. ` +
              "Runtime state may be partially cleaned — host should flag this reset as unpersisted.",
          );
        }
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
        // Manifest-middleware cleanup (audit sink close, etc.) is
        // deliberately NOT fired here. It runs on runtime.dispose()
        // AFTER the engine's onSessionEnd hooks complete, so audit
        // middleware's final `session_end` record is flushed to the
        // file before the writer is closed. shutdownBackgroundTasks
        // may be called before dispose (to drain bg work), which
        // would otherwise close the sink too early. See wrapping of
        // runtime.dispose above.
        // configHotReload is factory-bootstrap, not a stack feature —
        // dispose directly.
        configHotReload?.dispose();
        // Flush + close runtime-owned audit sink (opt-in via
        // config.auditNdjsonPath). Fire-and-forget because
        // shutdownBackgroundTasks is sync; any error is logged but does
        // not block shutdown. The process exits after this returns, so
        // the fire-and-forget close must complete synchronously relative
        // to the event loop before exit — createNdjsonAuditSink drains
        // its internal timer queue synchronously on close().
        if (auditMwForShutdown !== undefined) {
          const audit = auditMwForShutdown;
          void (async () => {
            try {
              await audit.flush();
              await audit.close();
            } catch (err) {
              console.warn(
                `[koi/${hostId}] audit shutdown failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          })();
        }
        return hadWork;
      },
    };
  } catch (assemblyErr) {
    // Any failure between manifest resolution and the return above
    // leaks any audit sinks/writers created at resolution time.
    // Unwind the registered cleanup callbacks before rethrowing so
    // partially-constructed resources are released.
    if (!handleOwnershipTransferred) {
      await unwindManifestMiddlewareHooks();
    }
    throw assemblyErr;
  }
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
