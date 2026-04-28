import type {
  AgentLoadWarning,
  AgentResolverDirs,
  RegistryConflictWarning,
} from "@koi/agent-runtime";
import type { ArtifactStore } from "@koi/artifacts";
import type { NdjsonRotationConfig } from "@koi/audit-sink-ndjson";
import type { SqliteRetentionConfig } from "@koi/audit-sink-sqlite";
import type { Checkpoint } from "@koi/checkpoint";
import type {
  AgentResolver,
  ApprovalHandler,
  AuditSink,
  BrowserDriver,
  ChannelAdapter,
  ChannelCapabilities,
  ComponentProvider,
  EngineAdapter,
  FileSystemBackend,
  FileSystemConfig,
  KoiMiddleware,
  OutcomeStore,
  ReportStore,
  RetrySignalReader,
  RichTrajectoryStep,
  SessionId,
  SpawnLedger,
  ToolDescriptor,
  ToolPolicy,
  TrajectoryDocumentStore,
} from "@koi/core";
import type { DecisionLedgerReader } from "@koi/decision-ledger";
import type { SpawnPolicy } from "@koi/engine-compose";
import type { GovernanceMiddlewareConfig } from "@koi/governance-core";
import type { LspClient, LspProviderConfig, LspServerFailure } from "@koi/lsp";
import type { MemoryStore, MemoryStoreConfig } from "@koi/memory-fs";
import type { ExfiltrationGuardConfig } from "@koi/middleware-exfiltration-guard";
import type { OtelMiddlewareConfig } from "@koi/middleware-otel";
import type { BrowserOperation } from "@koi/tool-browser";
import type { ActivityTimeoutConfig } from "./apply-activity-timeout.js";

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a runtime via the convenience config API. */
export interface RuntimeConfig {
  /** Engine adapter instance or "stub" for a passthrough stub. Default: "stub". */
  readonly adapter?: EngineAdapter | "stub" | undefined;

  /** Channel adapter instance or "stub" for a no-op CLI stub. Default: "stub". */
  readonly channel?: ChannelAdapter | "stub" | undefined;

  /** Middleware instances to include in the chain. Default: empty (all stubs). */
  readonly middleware?: readonly KoiMiddleware[] | undefined;

  /** Enable debug introspection (timing, inventory). Default: false. */
  readonly debug?: boolean | undefined;

  /**
   * Stream timeout in milliseconds. Applied as a wall-clock safety bound on
   * model stream consumption. Default: 120_000 (2 minutes).
   *
   * @deprecated Prefer `activityTimeout` for inactivity-based termination (#1638).
   *   When `activityTimeout` is not provided, `streamTimeoutMs` is mapped to
   *   `activityTimeout.maxDurationMs` to preserve existing wall-clock behavior.
   */
  readonly streamTimeoutMs?: number | undefined;

  /**
   * Inactivity-based stream termination (#1638). When configured, the runtime
   * resets an idle timer on each adapter event (model chunks, tool calls, tool
   * results, turn boundaries). Idle past `idleWarnMs` emits a
   * `custom:activity.idle.warning` event; idle past `idleTerminateMs`
   * (default 2 × idleWarnMs) aborts the stream with
   * `custom:activity.terminated.idle`. A `maxDurationMs` wall-clock bound acts
   * as a final safety net — the stream aborts regardless of activity.
   *
   * When both `streamTimeoutMs` and `activityTimeout` are provided,
   * `activityTimeout` wins.
   */
  readonly activityTimeout?: ActivityTimeoutConfig | undefined;

  /**
   * Directory for trajectory ATIF files. When provided, creates a
   * filesystem-backed TrajectoryDocumentStore. When omitted, no store is created.
   * Mutually exclusive with trajectoryNexus — providing both is a config error.
   */
  readonly trajectoryDir?: string | undefined;

  /**
   * Nexus trajectory storage config. When provided, trajectories are persisted
   * to a Nexus server instead of the local filesystem.
   * Mutually exclusive with trajectoryDir — providing both is a config error.
   */
  readonly trajectoryNexus?:
    | {
        readonly url: string;
        readonly apiKey?: string | undefined;
        readonly basePath?: string | undefined;
      }
    | undefined;

  /**
   * Called when trajectory flush fails (e.g., Nexus network error during persist).
   * When provided, the host can retry, alert, or fail the request.
   * When omitted, errors are logged to console.error.
   */
  readonly onTrajectoryFlushError?: ((error: unknown) => void) | undefined;

  /** Agent name for ATIF document metadata. Default: "koi-runtime". */
  readonly agentName?: string | undefined;

  /** Agent version for ATIF document metadata. */
  readonly agentVersion?: string | undefined;

  /**
   * Approval handler for permission-gated tool execution.
   * When provided, threaded into TurnContext.requestApproval so permission
   * middleware can prompt the user before executing dangerous tools.
   * When omitted and a non-stub "permissions" middleware is installed,
   * createRuntime throws — fail closed rather than silently allowing.
   */
  readonly requestApproval?: ApprovalHandler | undefined;

  /**
   * Handle from `createPermissionsMiddleware` for wiring approval trajectory
   * capture.  The runtime calls `setApprovalStepSink` with a dispatch relay
   * that routes approval decisions to the correct per-stream event-trace
   * `emitExternalStep`, so approval outcomes appear as `source:"user"` steps
   * in the ATIF trajectory.
   *
   * Structural type — no L2 import required.
   */
  readonly approvalStepHandle?:
    | {
        readonly setApprovalStepSink: (
          sink: (sessionId: string, step: RichTrajectoryStep) => void,
        ) => () => void;
      }
    | undefined;

  /**
   * Fallback sink for approval steps that the per-stream relay cannot
   * route. Fires only when (1) `RuntimeConfig.sessionId` is set so
   * multiple concurrent streams share one sessionId, AND (2) an
   * approval step arrives without `step.metadata.runId` so the
   * originating stream cannot be identified. Without this hook, the
   * runtime drops the step (logging per event) to prevent
   * cross-stream audit corruption / data leak from broadcast — wire
   * a session-level audit sink here to capture those records
   * instead of losing them.
   *
   * The typical cause is a version-skewed
   * `@koi/middleware-permissions` that does not stamp `runId` yet.
   * Upgrading the producer eliminates the fallback firing.
   */
  readonly onUnroutedApprovalStep?:
    | ((sessionId: string, step: RichTrajectoryStep) => void)
    | undefined;

  /**
   * Fixed session ID threaded into TurnContext.session.sessionId for every
   * stream() call. When provided, all turns in this runtime share the same
   * session routing key so middleware (e.g. transcript) writes to a single
   * persistent file. When omitted, each stream gets a unique UUID (default).
   *
   * Use this for multi-turn sessions that need transcript continuity, e.g.:
   *   createRuntime({ sessionId: mySessionId, middleware: [transcriptMw] })
   */
  readonly sessionId?: string | undefined;

  /** User identity for tenant-aware middleware. */
  readonly userId?: string | undefined;

  /** Channel identifier for channel-aware middleware. */
  readonly channelId?: string | undefined;

  /**
   * Tool descriptors advertised to cooperating adapters via callHandlers.tools.
   * Adapters use these to populate ModelRequest.tools so the model knows which
   * tools are available. When omitted, callHandlers.tools is empty.
   */
  readonly toolDescriptors?: readonly ToolDescriptor[] | undefined;

  /**
   * Agent resolver for definition lookup. When provided, `createRuntime` returns a
   * `spawnProvider` in `RuntimeHandle` that callers can pass to `createKoi({ providers })`
   * to register the `Spawn` tool and enable agent-to-agent delegation.
   *
   * Prefer `agentDirs` over `resolver` when you want the default bootstrap behaviour
   * (built-ins + `.koi/agents/` scanning). Use `resolver` when you need full control.
   */
  readonly resolver?: AgentResolver | undefined;

  /**
   * Convenience shortcut: directories to scan for agent definitions.
   * When provided (and `resolver` is not), `createRuntime` calls
   * `createAgentResolver(agentDirs)` internally and uses the result.
   * Load warnings (unparseable .md files) are emitted to `console.warn`.
   *
   * Example: `agentDirs: { projectDir: process.cwd() }`
   */
  readonly agentDirs?: AgentResolverDirs | undefined;

  /**
   * ReportStore for `on_demand` delivery. Required when spawned agents use
   * `delivery.kind === "on_demand"`. Passed through to the spawn provider.
   */
  readonly reportStore?: ReportStore | undefined;

  /**
   * Shared spawn ledger for process accounting. When provided it is threaded
   * into the spawn provider so cross-runtime/cross-node accounting is preserved.
   * When omitted a default in-memory ledger (capacity 50) is created locally.
   */
  readonly spawnLedger?: SpawnLedger | undefined;

  /**
   * Spawn governance policy (max depth, fan-out, total processes).
   * When omitted the DEFAULT_SPAWN_POLICY is used.
   */
  readonly spawnPolicy?: SpawnPolicy | undefined;

  /**
   * Filesystem backend configuration. Controls which FileSystemBackend
   * implementation is used.
   *
   * - `undefined`: falls back to `manifest.filesystem` if a manifest is provided.
   * - `FileSystemConfig`: explicitly configures the backend (resolved synchronously).
   * - `FileSystemBackend`: a pre-created backend (e.g., from resolveFileSystemAsync
   *   when using the local bridge transport with auth notification wiring).
   * - `false`: explicitly disables filesystem, overriding any manifest config.
   *   Use this to prevent manifest-supplied filesystem grants from taking effect.
   */
  readonly filesystem?: FileSystemConfig | FileSystemBackend | false | undefined;

  /**
   * Working directory for the local filesystem backend. Required when
   * filesystem.backend is "local" (or absent). Defaults to process.cwd().
   */
  readonly cwd?: string | undefined;

  /**
   * Which filesystem operations to expose as agent tools when `filesystem` is a
   * pre-created `FileSystemBackend` (e.g., from `resolveFileSystemAsync()`).
   * Ignored when `filesystem` is a `FileSystemConfig` — operations come from the config.
   *
   * Default: `["read"]` (the `createFileSystemProvider` default).
   * Set explicitly to `["read", "write", "edit"]` to restore mutation tools.
   */
  readonly filesystemOperations?: readonly ("read" | "write" | "edit")[] | undefined;

  /**
   * Session transcript configuration. When provided, wires a JSONL-backed
   * transcript store as an observe-phase middleware, recording turns for crash
   * recovery. Each turn is appended as a TranscriptEntry to a per-session .jsonl
   * file under `transcriptDir`.
   *
   * When omitted, no transcript middleware is added.
   */
  readonly session?:
    | {
        /** Directory for per-session JSONL transcript files. */
        readonly transcriptDir: string;
      }
    | undefined;

  /**
   * Checkpoint configuration for session-level rollback (#1625).
   *
   * When provided, wires `@koi/checkpoint` and `@koi/snapshot-store-sqlite`:
   *   - end-of-turn snapshots capture file ops to a CAS blob store
   *   - the chain DAG persists in SQLite at `snapshotPath`
   *   - if `config.session.transcriptDir` is also set, the same `SessionTranscript`
   *     is wired in so /rewind also truncates the conversation log
   *
   * The resulting `Checkpoint` handle is exposed on the RuntimeHandle as
   * `runtime.checkpoint`, providing programmatic `rewind(sessionId, n)` and
   * `rewindTo(sessionId, nodeId)` methods.
   *
   * When omitted, no checkpoint middleware is added and `runtime.checkpoint`
   * is `undefined`.
   */
  readonly checkpoint?:
    | {
        /** SQLite database path for the snapshot chain. Default: `:memory:`. */
        readonly snapshotPath?: string | undefined;
        /** Content-addressed blob directory for file pre/post-image storage. */
        readonly blobDir: string;
      }
    | undefined;

  /**
   * Artifact store wiring (@koi/artifacts). When provided, the runtime
   * attaches a ComponentProvider that exposes four artifact tools to
   * every agent: artifact_save, artifact_get, artifact_list,
   * artifact_delete. All calls run as the supplied `sessionId`.
   *
   * The caller owns the `ArtifactStore` lifecycle — `runtime.dispose()`
   * does NOT call `store.close()` so the same store can outlive a
   * single runtime instance (e.g. reused across TUI restarts).
   *
   * Omit to skip artifact tooling entirely; the runtime handle's
   * `artifacts` field is then `undefined`. Plan 6 (#1923) will extend
   * the scoping story so each agent operates on its own per-session
   * namespace without the caller preselecting a sessionId here.
   */
  readonly artifacts?:
    | {
        readonly store: ArtifactStore;
        readonly sessionId: SessionId;
      }
    | undefined;

  /**
   * Retry signal reader for cross-middleware retry coordination.
   * When provided, event-trace middleware annotates trajectory steps with
   * retry metadata (outcome: "retry", retryOfTurn, retryAttempt, etc.).
   *
   * The caller creates a RetrySignalBroker externally, passes the writer
   * side to their semantic-retry middleware and the reader side here.
   * This keeps L2 composition clean — the runtime doesn't need to know
   * about the semantic-retry package.
   */
  readonly retrySignalReader?: RetrySignalReader | undefined;

  /**
   * Exfiltration guard middleware configuration. Default: enabled (action: "block").
   * Scans tool I/O and model output for secret exfiltration attempts.
   * Pass `false` to disable. Pass partial config to customize (e.g., action: "warn").
   * Ignored if a middleware named "exfiltration-guard" is already in `middleware`.
   */
  readonly exfiltrationGuard?: Partial<ExfiltrationGuardConfig> | false | undefined;

  /**
   * Credential path guard for filesystem tools. Default: enabled.
   * Blocks fs_read/fs_write/fs_edit access to ~/.ssh, ~/.aws, ~/.docker,
   * ~/.gnupg, ~/.config/gcloud, ~/.azure, ~/.kube and sensitive dotfiles.
   * Pass `false` to disable (e.g., for testing or trusted environments).
   */
  readonly credentialPathGuard?: false | undefined;

  /**
   * OpenTelemetry GenAI semantic convention span emission. Default: disabled.
   *
   * When provided, wires `@koi/middleware-otel` per-stream so every model call
   * and tool call emits an OTel span with GenAI attributes (gen_ai.operation.name,
   * gen_ai.provider.name, gen_ai.usage.input_tokens, etc.).
   *
   * Requires an OTel tracer provider registered globally (or per tracerName).
   * Only `@opentelemetry/api` is bundled — the SDK (exporter, processor) must be
   * wired by the host application before calling createRuntime.
   *
   * @example
   *   // Host wires SDK once:
   *   const provider = new BasicTracerProvider({ spanProcessors: [new OTLPTraceExporter()] });
   *   trace.setGlobalTracerProvider(provider);
   *
   *   // Then enable in runtime config:
   *   createRuntime({ otel: true })               // default tracer name
   *   createRuntime({ otel: { tracerName: "my-app" } })
   *   createRuntime({ otel: { captureContent: true } })  // opt-in prompt capture
   */
  /**
   * OpenTelemetry GenAI semantic convention span emission. Default: disabled.
   *
   * When provided, wires `@koi/middleware-otel` per-stream so every model call
   * and tool call emits an OTel span with GenAI attributes (gen_ai.operation.name,
   * gen_ai.provider.name, gen_ai.usage.input_tokens, etc.).
   *
   * Requires an OTel tracer provider registered globally before calling createRuntime.
   * Only `@opentelemetry/api` is bundled — the SDK (exporter, processor) must be
   * wired by the host application.
   *
   * - `true`: enable with all defaults
   * - `OtelMiddlewareConfig`: enable with custom tracer name / content capture
   * - `false` / `undefined`: disabled (default)
   *
   * @example
   *   // Host wires SDK once:
   *   const provider = new BasicTracerProvider({ spanProcessors: [new OTLPTraceExporter()] });
   *   trace.setGlobalTracerProvider(provider);
   *
   *   createRuntime({ otel: true })
   *   createRuntime({ otel: { tracerName: "my-app", captureContent: true } })
   */
  readonly otel?: OtelMiddlewareConfig | true | false | undefined;

  /**
   * Base clock for trajectory timestamps. Each stream creates its own
   * monotonic wrapper around this base clock, so concurrent sessions
   * never interfere with each other's timestamp sequences.
   * Default: Date.now (wrapped in createMonotonicClock per stream).
   */
  readonly clock?: (() => number) | undefined;

  /**
   * Pre-constructed model-router middleware. When provided, routes all model
   * calls through the failover chain before reaching the model adapter.
   * Create via: createModelRouterMiddleware(createModelRouter(config, adapters))
   *
   * Placed innermost (after semantic-retry when present) so each retry attempt
   * independently benefits from provider failover. When omitted, calls go
   * directly to the adapter terminals (no routing).
   *
   * Ignored if a middleware named "model-router" is already in `middleware`.
   */
  readonly modelRouterMiddleware?: KoiMiddleware | undefined;

  /**
   * Audit middleware configuration. When provided, wires `@koi/middleware-audit`
   * with the selected sink into the middleware chain (observe phase).
   *
   * `sink` accepts:
   *   - `{ kind: "ndjson", filePath, ... }` — construct an NDJSON file sink
   *     via `@koi/audit-sink-ndjson`.
   *   - `{ kind: "sqlite", dbPath, ... }` — construct a SQLite sink via
   *     `@koi/audit-sink-sqlite`.
   *   - A pre-built `AuditSink` — use directly (caller owns lifecycle).
   *
   * When omitted, no audit middleware is installed.
   */
  readonly audit?:
    | {
        readonly sink:
          | {
              readonly kind: "ndjson";
              readonly filePath: string;
              readonly flushIntervalMs?: number | undefined;
              readonly rotation?: NdjsonRotationConfig | undefined;
            }
          | {
              readonly kind: "sqlite";
              readonly dbPath: string;
              /**
               * Scope all sink operations (reads and pruning) to this agent ID.
               * When set, query() filters by (session_id AND agent_id), and the
               * retention DELETE subquery is further restricted to that agent's rows.
               * Use in shared databases to prevent cross-agent audit reads and
               * cross-agent prune collisions. Callers that need to read audit rows
               * across multiple agents (e.g. multi-agent compliance review) should
               * omit this field and filter programmatically.
               * Omit for single-agent deployments.
               */
              readonly agentId?: string | undefined;
              readonly flushIntervalMs?: number | undefined;
              readonly maxBufferSize?: number | undefined;
              readonly retention?: SqliteRetentionConfig | undefined;
            }
          | AuditSink;
        readonly maxQueueDepth?: number | undefined;
        readonly signing?: boolean | undefined;
        readonly redactRequestBodies?: boolean | undefined;
      }
    | undefined;

  /**
   * Governance middleware configuration. When provided, wires `@koi/governance-core`
   * into the middleware chain at priority 150 (between permissions=100 and audit=300).
   *
   * Skipped if a middleware named "koi:governance-core" is already in `middleware`.
   *
   * When omitted, no governance middleware is installed.
   */
  readonly governance?: GovernanceMiddlewareConfig | undefined;

  /**
   * Feedback-loop middleware configuration. When provided, wires
   * `@koi/middleware-feedback-loop` which validates model responses,
   * retries on validation failure, and tracks tool health (quarantine +
   * trust demotion). Skipped if a middleware named "feedback-loop" is
   * already present in `config.middleware`.
   */
  readonly feedbackLoop?: import("@koi/middleware-feedback-loop").FeedbackLoopConfig | undefined;

  /**
   * Circuit breaker middleware configuration. When provided, wires
   * `@koi/middleware-circuit-breaker` which fails fast on unhealthy
   * model providers (CLOSED → OPEN → HALF_OPEN state machine).
   *
   * Pass an object to customize (`breaker.failureThreshold`, `cooldownMs`,
   * `extractKey` for tenant-scoped keys, `maxKeys`). Pass `false` to
   * explicitly disable. Default (omitted): not installed.
   *
   * Skipped if a middleware named "koi:circuit-breaker" is already in
   * `config.middleware`.
   */
  readonly circuitBreaker?:
    | import("@koi/middleware-circuit-breaker").CircuitBreakerMiddlewareConfig
    | false
    | undefined;

  /**
   * Call-limits middleware configuration. When provided, wires
   * `@koi/middleware-call-limits` — independent per-tool/global tool
   * and model-call budgets per session. Provide either or both.
   *
   * Skipped per-name if a middleware named "koi:tool-call-limit" or
   * "koi:model-call-limit" is already in `config.middleware`.
   */
  readonly callLimits?:
    | {
        readonly tool?: import("@koi/middleware-call-limits").ToolCallLimitConfig | undefined;
        readonly model?: import("@koi/middleware-call-limits").ModelCallLimitConfig | undefined;
      }
    | false
    | undefined;

  /**
   * Call-dedup middleware configuration. When provided, wires
   * `@koi/middleware-call-dedup` to cache identical deterministic tool
   * call results within a session.
   *
   * Opt-in: requires an explicit `include` allowlist of tool ids the
   * caller has proven deterministic against immutable inputs. Without
   * `include`, the middleware is a passthrough.
   *
   * Skipped if a middleware named "koi:call-dedup" is already in
   * `config.middleware`.
   */
  readonly callDedup?: import("@koi/middleware-call-dedup").CallDedupConfig | false | undefined;

  /**
   * Acknowledgement that cache-hit observability is wired even when
   * `koi:call-dedup` is injected via `config.middleware` rather than
   * the auto-install path. Set to `true` only after confirming that
   * the caller-injected dedup middleware forwards cache hits to your
   * audit / event-trace / OTel pathway (e.g., via its own
   * `onCacheHit` callback).
   *
   * Without this acknowledgement, the runtime refuses to compose a
   * caller-injected dedup alongside observe-phase middleware or
   * runtime-added observers (audit / trajectory store / otel),
   * because dedup short-circuits the observe-phase chain on cache
   * hits and coalesced waiters — leaving those observers silently
   * blind otherwise.
   */
  readonly callDedupObservabilityAck?: boolean | undefined;

  /**
   * Forge-demand detector configuration. When provided, wires
   * `@koi/forge-demand` as a passive observer on tool/model traffic to
   * surface forge-demand signals (repeated_failure, capability_gap,
   * user_correction, performance_degradation). When provided alongside a
   * caller-supplied `forge-demand-detector` middleware in
   * `config.middleware`, the runtime-owned instance REPLACES the
   * preinstalled one so `RuntimeHandle.forgeDemand` always points at the
   * active detector. Omit this config to keep a preinstalled middleware
   * intact (the caller owns its handle out-of-band).
   */
  readonly forgeDemand?: RuntimeForgeDemandConfig | undefined;

  /**
   * Browser tool provider configuration. When provided, wires `@koi/tool-browser`
   * and exposes the resulting `ComponentProvider` on `RuntimeHandle.browserProvider`
   * so callers can pass it to `createKoi({ providers })`.
   *
   * `backend` must be unshared per runtime: `@koi/tool-browser`'s provider
   * disposes the backend when its internal ref-count reaches zero during
   * `createKoi().dispose()`. A driver passed to two runtimes would be torn
   * down the first time either one detaches. Construct a fresh
   * `BrowserDriver` via `@koi/browser-playwright` (or equivalent) per
   * runtime instance.
   */
  readonly browser?:
    | {
        readonly backend: BrowserDriver;
        readonly operations?: readonly BrowserOperation[] | undefined;
        readonly prefix?: string | undefined;
        readonly policy?: ToolPolicy | undefined;
        readonly isUrlAllowed?: ((url: string) => boolean | Promise<boolean>) | undefined;
      }
    | undefined;

  /**
   * LSP tool provider configuration. When provided, `@koi/lsp`'s
   * `createLspComponentProvider` is invoked asynchronously. The resulting promise
   * is exposed on `RuntimeHandle.lspProvider` — callers `await` it before passing
   * `.provider` to `createKoi({ providers })`, and inspect `.failures` for any
   * servers that failed to start.
   */
  readonly lsp?: LspProviderConfig | undefined;

  /**
   * File-based memory store configuration. When provided, `@koi/memory-fs`'s
   * `createMemoryStore` is invoked and the resulting `MemoryStore` is exposed on
   * `RuntimeHandle.memoryStore`. A `MemoryToolBackend` adapter that plugs this
   * store into `@koi/memory-tools` is tracked as follow-up work; for now callers
   * wanting memory tools can use the in-memory preset or provide their own adapter.
   */
  readonly memoryFs?: MemoryStoreConfig | undefined;
}

/**
 * Runtime-narrowed `ForgeDemandConfig`. The runtime intentionally does
 * NOT expose a sessionId-keyed lookup (F67), and `onDemand` alone is
 * insufficient because it has no dismiss capability — emitted signals
 * stay in detector state until acknowledged, so the same condition
 * can re-emit after cooldown and eventually consume the session forge
 * budget. The scoped handle delivered to `onSessionAttached` is the
 * only surface that supports both read and dismiss; making it
 * required at the type level prevents callers from constructing a
 * runtime config that the factory will then reject at startup.
 * F102 regression.
 */
export type RuntimeForgeDemandConfig = Omit<
  import("@koi/forge-demand").ForgeDemandConfig,
  "onSessionAttached"
> & {
  readonly onSessionAttached: NonNullable<
    import("@koi/forge-demand").ForgeDemandConfig["onSessionAttached"]
  >;
};

/** Default stream timeout: 2 minutes for live API calls. */
export const DEFAULT_STREAM_TIMEOUT_MS = 120_000 as const;

/**
 * Default wall-clock fallback for `activityTimeout.maxDurationMs` (#1638).
 * When a caller supplies `activityTimeout` without an explicit `maxDurationMs`,
 * the runtime fills in this 4-hour cap so no stream is ever unbounded — idle
 * timers do the bulk of termination, but a final wall-clock safety net stays
 * in place as a rollback-safe backstop.
 */
export const DEFAULT_ACTIVITY_MAX_DURATION_MS = 14_400_000 as const;

// ---------------------------------------------------------------------------
// Debug introspection
// ---------------------------------------------------------------------------

/** Middleware inventory entry for debug introspection. */
export interface MiddlewareDebugEntry {
  readonly name: string;
  readonly phase: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly stubbed: boolean;
}

/** Tool inventory entry for debug introspection. */
export interface ToolDebugEntry {
  readonly name: string;
  readonly source: string;
}

/** Debug introspection handle returned by createRuntime when debug is enabled. */
export interface RuntimeDebugInfo {
  readonly middleware: readonly MiddlewareDebugEntry[];
  readonly tools: readonly ToolDebugEntry[];
  readonly adapter: { readonly name: string; readonly stubbed: boolean };
  readonly channel: { readonly name: string; readonly capabilities: ChannelCapabilities };
}

// ---------------------------------------------------------------------------
// Runtime handle
// ---------------------------------------------------------------------------

/**
 * Runtime-facing forge-demand handle.
 *
 * The L2 detector authorizes session-scoped operations by SessionContext
 * object identity (engine-issued, not caller-supplied) — see F61. The
 * runtime intentionally does NOT expose a sessionId-keyed lookup like
 * `forSessionId(sid)` here, because that would let any in-process caller
 * with a sessionId read or dismiss another tenant's signals (F67).
 * Instead, scoped handles are delivered to the legitimate session owner
 * via the `forgeDemand.onSessionAttached` callback supplied at runtime
 * configuration time. The owner stores its handle and acks/dismisses
 * its own signals — no out-of-band lookup surface.
 *
 * The `middleware` field is exposed for assembly inspection only —
 * wiring is automatic.
 */
export interface RuntimeForgeDemandHandle {
  readonly middleware: import("@koi/core").KoiMiddleware;
}

/** The assembled runtime returned by createRuntime. */
export interface RuntimeHandle {
  readonly adapter: EngineAdapter;
  readonly channel: ChannelAdapter;
  readonly middleware: readonly KoiMiddleware[];

  /** Debug introspection. Only populated when config.debug is true. */
  readonly debugInfo: RuntimeDebugInfo | undefined;

  /**
   * Trajectory document store for rich execution traces.
   * Only populated when config.trajectoryDir is provided.
   * Shared between harness (writes DebugSpans) and event-trace (writes RichTrajectorySteps).
   */
  readonly trajectoryStore: TrajectoryDocumentStore | undefined;

  /**
   * Spawn tool provider. Only populated when `config.resolver` or `config.agentDirs` is provided.
   * Pass this to `createKoi({ providers: [handle.spawnProvider] })` to register
   * the `Spawn` tool and enable agent-to-agent delegation for that agent.
   */
  readonly spawnProvider: ComponentProvider | undefined;

  /**
   * Agent load warnings from `config.agentDirs` resolution (unparseable .md files).
   * Only populated when `config.agentDirs` is used (not when `config.resolver` is explicit).
   * A warning for a built-in agent type means that type is poisoned — callers should
   * inspect this and decide whether to fail, log, or proceed with reduced spawn coverage.
   */
  readonly agentWarnings: readonly AgentLoadWarning[];

  /**
   * Same-tier agent conflicts from `config.agentDirs` resolution.
   * The first definition wins; the rest are ignored. Non-empty means some `.koi/agents/`
   * files were silently skipped — callers should log or surface these to operators.
   */
  readonly agentConflicts: readonly RegistryConflictWarning[];

  /**
   * Outcome store for decision-to-business-outcome correlation (#1465).
   * Only populated when config.trajectoryNexus is provided (shares transport).
   * Phase 1: put + get only. Stores at /outcomes/{correlationId}.json.
   */
  readonly outcomeStore: OutcomeStore | undefined;

  /**
   * Checkpoint handle for programmatic session rollback (#1625).
   * Only populated when `config.checkpoint` is provided.
   *
   * Exposes `rewind(sessionId, n)` and `rewindTo(sessionId, nodeId)` for
   * file-state and conversation-log rollback. The TUI's `/rewind` slash
   * command and any programmatic caller use this handle.
   */
  readonly checkpoint: Checkpoint | undefined;

  /**
   * Artifact wiring handle (@koi/artifacts). Only populated when
   * `config.artifacts` is provided. `store` is the exact instance the
   * caller passed in (the runtime does NOT own its lifecycle). `provider`
   * is a ComponentProvider exposing artifact_save/get/list/delete —
   * forward it to `createKoi({ providers })` so every spawned agent sees
   * the tools.
   */
  readonly artifacts:
    | {
        readonly store: ArtifactStore;
        readonly provider: ComponentProvider;
      }
    | undefined;

  /**
   * Resolved filesystem backend. Only populated when filesystem is explicitly
   * configured via config.filesystem or manifest.filesystem (opt-in).
   */
  readonly filesystemBackend: FileSystemBackend | undefined;

  /**
   * Filesystem ComponentProvider — registers the backend under FILESYSTEM token
   * and creates fs_read, fs_write, fs_edit tools. Pass to createKoi() providers.
   * Only populated when filesystem is explicitly configured.
   */
  readonly filesystemProvider: ComponentProvider | undefined;

  /**
   * Factory for a per-session decision ledger reader over the runtime's
   * configured sinks. Undefined when `trajectoryStore` is not configured,
   * since trajectory is the required input for the ledger.
   *
   * The ledger joins the runtime's `trajectoryStore`, the optional
   * `auditSink` passed to this factory, and the runtime's `reportStore`
   * (or an override passed to this factory). See `@koi/decision-ledger`
   * and `docs/L2/decision-ledger.md` for the full contract.
   *
   * Phase 2(a) ships with trajectory-only surfacing in practice because
   * no default `AuditSink` or `ReportStore` implementation exists yet
   * — both are tracked as follow-up work. Incident tooling that has its
   * own audit/report stores can inject them via `overrides` without
   * rebuilding the runtime.
   */
  readonly createDecisionLedger:
    | ((overrides?: {
        readonly auditSink?: AuditSink | undefined;
        readonly reportStore?: ReportStore | undefined;
      }) => DecisionLedgerReader)
    | undefined;

  /**
   * Browser tool ComponentProvider. Only populated when `config.browser` is
   * provided. Pass to `createKoi({ providers: [handle.browserProvider] })` to
   * register browser tools (snapshot, navigate, click, etc.) on the agent.
   *
   * Declared optional so downstream mocks / test harnesses built against
   * older `RuntimeHandle` definitions keep compiling without requiring a
   * coordinated update to every mock.
   */
  readonly browserProvider?: ComponentProvider | undefined;

  /**
   * LSP tool provider thunk. Only populated when `config.lsp` is provided.
   *
   * Call it to start language-server subprocesses on demand and await the
   * returned promise before passing `.provider` to `createKoi({ providers })`.
   * The returned value also exposes `.failures` (servers that failed to
   * start) and `.clients` (underlying LspClient[] for advanced lifecycle
   * management — usually `runtime.dispose()` handles cleanup).
   *
   * Startup is lazy so a runtime created and disposed without ever asking
   * for LSP tools does not spawn subprocesses that outlive `dispose()`.
   * Repeated calls return the same cached promise.
   */
  readonly lspProvider?:
    | (() => Promise<{
        readonly provider: ComponentProvider;
        readonly clients: readonly LspClient[];
        readonly failures: readonly LspServerFailure[];
      }>)
    | undefined;

  /**
   * File-based memory store. Only populated when `config.memoryFs` is provided.
   * Exposes the raw `MemoryStore` CRUD surface; a `MemoryToolBackend` adapter
   * for `@koi/memory-tools` is tracked as follow-up work.
   */
  readonly memoryStore?: MemoryStore | undefined;

  /**
   * Forge-demand handle. Only populated when `config.forgeDemand` is provided.
   *
   * @see RuntimeForgeDemandHandle
   * Exposes `forSessionId(sessionId)` to obtain a session-scoped view of
   * pending signals — runtime callers do not have direct access to the
   * engine-issued `SessionContext` object, so a sessionId-keyed surface
   * is the only operable inspection path. Without this, signals would
   * re-fire after cooldown expiry and consume the per-session forge
   * budget until session end. Throws when the sessionId has not been
   * observed in the runtime — there is no cross-tenant aggregator.
   */
  readonly forgeDemand?: RuntimeForgeDemandHandle | undefined;

  /** Dispose all resources. */
  readonly dispose: () => Promise<void>;
}
