/**
 * L1-specific configuration types for the engine factory and spawn.
 *
 * Guard types are re-exported from @koi/engine-compose.
 * Governance types are re-exported from @koi/engine-reconcile.
 */

import type {
  Agent,
  AgentGroupId,
  AgentManifest,
  AgentRegistry,
  ApprovalHandler,
  BrickComponentMap,
  BrickKind,
  ChannelStatus,
  ChildHandle,
  ComponentProvider,
  DelegationId,
  DeliveryPolicy,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  ForgeScope,
  KernelExtension,
  KoiMiddleware,
  ProcessAccounter,
  ProcessId,
  SessionId,
  SpawnInheritanceConfig,
  SpawnLedger,
  StoreChangeEvent,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import type {
  DebugInstrumentationConfig,
  DebugInventory,
  DebugInventoryItem,
  DebugTurnTrace,
  IterationLimits,
  LoopDetectionConfig,
  SpawnPolicy,
  ToolExecutionConfig,
} from "@koi/engine-compose";
import type { GovernanceConfig } from "@koi/engine-reconcile";
import type { AssemblyConflict } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Live forge resolution
// ---------------------------------------------------------------------------

/**
 * Enables forged capabilities to be used without agent re-assembly.
 *
 * Tools: resolved at call time (immediate). Descriptors refreshed at turn boundary.
 * Middleware: re-composed at turn boundary (next turn picks up new middleware).
 *
 * All methods use L0 types only — L2 (forge) provides the implementation.
 */
export interface ForgeRuntime {
  /** Resolve a forged tool by name. Returns undefined if not found or not accessible. */
  readonly resolveTool: (toolId: string) => Promise<Tool | undefined>;
  /** Get descriptors for all currently available forged tools. */
  readonly toolDescriptors: () => Promise<readonly ToolDescriptor[]>;
  /**
   * Get currently active forged middleware. Re-queried at turn boundaries.
   * Forged middleware participates in wrapper hooks only (wrapModelCall, wrapModelStream,
   * wrapToolCall). It does NOT participate in lifecycle hooks (onSessionStart/End,
   * onBeforeTurn/AfterTurn) or describeCapabilities.
   */
  readonly middleware?: () => Promise<readonly KoiMiddleware[]>;
  /** Push notification when forged capabilities change. Returns unsubscribe. */
  readonly watch?: (listener: (event: StoreChangeEvent) => void) => () => void;
  /** Generic per-kind resolution. Optional for backward compatibility. */
  readonly resolve?: <K extends BrickKind>(
    kind: K,
    name: string,
  ) => Promise<BrickComponentMap[K] | undefined>;
}

// ---------------------------------------------------------------------------
// Factory API
// ---------------------------------------------------------------------------

export interface CreateKoiOptions {
  /** The agent manifest describing the agent's configuration. */
  readonly manifest: AgentManifest;
  /** The engine adapter that provides the agent loop. */
  readonly adapter: EngineAdapter;
  /** Additional middleware to compose (L2 middleware). Order matters — first runs outermost. */
  readonly middleware?: readonly KoiMiddleware[];
  /** Component providers to attach during assembly. */
  readonly providers?: readonly ComponentProvider[];
  /** Iteration guard limits. Defaults to DEFAULT_ITERATION_LIMITS. */
  readonly limits?: Partial<IterationLimits>;
  /** Loop detection configuration. Defaults to DEFAULT_LOOP_DETECTION. Set to false to disable. */
  readonly loopDetection?: Partial<LoopDetectionConfig> | false;
  /** Spawn governance policy. Defaults to DEFAULT_SPAWN_POLICY. */
  readonly spawn?: Partial<SpawnPolicy>;
  /** Tool execution config (abort propagation + per-tool timeouts). Set to false to disable. */
  readonly toolExecution?: Partial<ToolExecutionConfig> | false;
  /**
   * Kernel extensions for pluggable guards, lifecycle validation, and assembly validation.
   * Extensions are composed with the default guard extension (created from limits/loopDetection/spawn).
   */
  readonly extensions?: readonly KernelExtension[];
  /**
   * Shared spawn ledger for tree-wide concurrency tracking.
   * The root agent creates a ledger; children share the same instance.
   * Defaults to an in-memory counter (single-Node scope).
   * Provide a custom implementation for multi-Node/distributed tracking.
   */
  readonly spawnLedger?: SpawnLedger;
  /** Governance controller configuration. Defaults to DEFAULT_GOVERNANCE_CONFIG. */
  readonly governance?: Partial<GovernanceConfig>;
  /**
   * When `true`, fire `iteration_reset` on the governance controller at the
   * start of every `runtime.run()` invocation, giving each run a fresh
   * per-iteration turn count and duration window. Token usage, cost, spawn
   * counts, and rolling error-rate windows are NOT reset — those continue to
   * accumulate across runs because they track runtime/session-scoped
   * resources. To reset everything, call `cycleSession()` (which fires
   * `session_reset`) instead.
   *
   * Defaults to `false` so cumulative session-level enforcement remains the
   * default contract for batch / headless / `koi start` hosts. Interactive
   * hosts that expose user-visible run boundaries (e.g. the TUI, where each
   * user submit is logically a fresh request) opt in by setting `true`.
   * #1742.
   */
  readonly resetIterationBudgetPerRun?: boolean;
  /** Optional approval handler for HITL permission gating. */
  readonly approvalHandler?: ApprovalHandler;
  /** Optional live forge runtime — enables forged tools/middleware without agent re-assembly. */
  readonly forge?: ForgeRuntime;
  /**
   * Optional callback returning dynamic middleware (e.g., debug middleware).
   * Queried at turn boundaries. When the returned reference changes (identity check),
   * middleware chains are re-composed to include the dynamic middleware.
   */
  readonly dynamicMiddleware?: (() => readonly KoiMiddleware[] | undefined) | undefined;
  /** Optional shared process accounter for cross-agent spawn accounting. */
  readonly processAccounter?: ProcessAccounter;
  /** Optional status handler for turn lifecycle notifications. L1 threads this into TurnContext. */
  readonly sendStatus?: (status: ChannelStatus) => Promise<void>;
  /** Parent process ID. When provided, child PID is generated with parent reference. */
  readonly parentPid?: ProcessId;
  /** Registry for agent lifecycle tracking. If provided, agent is registered on creation. */
  readonly registry?: AgentRegistry;
  /** Authenticated user identity. Injected into SessionContext. */
  readonly userId?: string;
  /** Channel adapter package name (e.g. "@koi/channel-telegram"). Injected into SessionContext. */
  readonly channelId?: string;
  /** Stable conversation ID that spans multiple runtime.run() calls. Injected into SessionContext. */
  readonly conversationId?: string;
  /**
   * Optional override for the factory-level session id.
   *
   * By default, `createKoi` mints a composite id of the form
   * `agent:{agentId}:{uuid}` at factory-construction time. Hosts that
   * need a user-facing, human-typable session id (e.g. `koi tui` for
   * its post-quit resume hint) can pass a pre-branded `SessionId`
   * here; the factory will use that value verbatim for both
   * `runtime.sessionId` and `ctx.session.sessionId`, which is what
   * the session-transcript middleware routes on.
   *
   * Callers are responsible for uniqueness — the factory trusts the
   * override. Collisions in the session-transcript directory result
   * in appends to an existing JSONL file (which is how `--resume`
   * works on top of this knob).
   */
  readonly sessionId?: SessionId;
  /**
   * Optional host-controlled session-id rotation strategy.
   *
   * `cycleSession()` (invoked by hosts on conversation boundaries
   * like `koi tui`'s `/clear`) rotates the factory-scoped session id
   * so checkpoint chains and other session-keyed durable state are
   * isolated across resets. By default, rotation mints a fresh
   * composite id in the `agent:{agentId}:{uuid}` format.
   *
   * Hosts that supplied their own `sessionId` via the option above
   * usually want to keep that format alive across rotations — e.g.
   * `koi tui` prints the session id in its post-quit resume hint
   * and keys its JSONL file on it. They pass a callback that returns
   * the next id (stable across calls is fine: returning the same
   * host-owned UUID each time makes `/clear` wipe-and-rewrite the
   * same file, preserving the resume contract).
   *
   * When absent, rotation falls back to the default composite form.
   */
  readonly rotateSessionId?: () => SessionId;
  /** Process group to assign this agent to. Recorded in the registry entry and ProcessId. */
  readonly groupId?: AgentGroupId | undefined;
  /** Debug instrumentation configuration. When enabled, records per-middleware timing spans. */
  readonly debug?: DebugInstrumentationConfig | undefined;
}

export interface KoiRuntime {
  /** The assembled agent entity. */
  readonly agent: Agent;
  /** The session ID assigned to this runtime instance. */
  readonly sessionId: string;
  /** Component key conflicts detected during assembly. Empty when no keys collide. */
  readonly conflicts: readonly AssemblyConflict[];
  /** Run the agent with the given input. Returns an async iterable of engine events. */
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  /**
   * Cycle session-scoped middleware state without disposing the runtime.
   *
   * Fires `onSessionEnd` then re-arms `onSessionStart` on the next `run()`
   * so session-scoped middleware state (caches, always-allow grants, goal
   * completion, skill snapshots, hot memory, etc.) is dropped and
   * re-initialized at a host-driven boundary like the TUI's `/clear` or
   * `session:new` commands.
   *
   * Optional — hosts that don't expose user-visible session boundaries
   * (and most test/mock runtimes) can leave this undefined; `onSessionEnd`
   * still fires once on `dispose()`. Hosts must ensure no run is in flight
   * when calling this; cycling mid-run is undefined behavior.
   */
  readonly cycleSession?: () => Promise<void>;
  /**
   * Rebind the runtime's session identity to a specific id.
   *
   * Use this immediately after `cycleSession()` when resuming a saved
   * session: cycleSession rotates the engine sessionId to a fresh
   * UUID, but a resume flow needs future turns to be persisted under
   * the user-selected session id (so checkpoints, transcripts, and
   * `/rewind` operate on the resumed chain instead of starting a
   * fresh chain).
   *
   * Requirements:
   * - Must be called when no run is in flight (between cycleSession
   *   and the next run()).
   * - Must NOT be called on a disposed or poisoned runtime.
   *
   * Optional — hosts that don't expose session resume can leave this
   * undefined.
   */
  readonly rebindSessionId?: (id: string) => void;
  /** Dispose the runtime and release resources. */
  readonly dispose: () => Promise<void>;
  /** Debug instrumentation accessors. Only present when `debug.enabled` is true. */
  readonly debug?:
    | {
        /** Get the trace for a specific turn. Returns undefined if not found. */
        readonly getTrace: (turnIndex: number) => DebugTurnTrace | undefined;
        /** Build a snapshot of all registered middleware, tools, and other components. */
        readonly getInventory: (extraItems?: readonly DebugInventoryItem[]) => DebugInventory;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Spawn child types
// ---------------------------------------------------------------------------

/**
 * Options for spawning a child agent via `spawnChildAgent()`.
 *
 * Ledger management is tied to child lifetime (released on termination),
 * unlike the spawn guard's fan-out which is tied to tool call duration.
 */
export interface SpawnChildOptions {
  /** The parsed agent manifest for the child. */
  readonly manifest: AgentManifest;
  /** The engine adapter for the child's agent loop. Caller provides explicitly. */
  readonly adapter: EngineAdapter;
  /** The parent agent entity (used for component inheritance). */
  readonly parentAgent: Agent;
  /** Shared spawn ledger for tree-wide process tracking. */
  readonly spawnLedger: SpawnLedger;
  /** Spawn governance policy. Used for depth/fan-out validation. */
  readonly spawnPolicy: SpawnPolicy;
  /** Registry for lifecycle tracking. If provided, child is registered with parentId. */
  readonly registry?: AgentRegistry;
  /** Additional middleware for the child. */
  readonly middleware?: readonly KoiMiddleware[];
  /** Additional component providers for the child (beyond inherited). */
  readonly providers?: readonly ComponentProvider[];
  /** Optional forge runtime for the child. */
  readonly forge?: ForgeRuntime;
  /**
   * Optional scope checker for filtering inherited tools.
   * @deprecated Use `inheritance.tools.scopeChecker` instead.
   */
  readonly scopeChecker?: (toolName: string) => ForgeScope | undefined;
  /** Unified inheritance configuration for tools, channels, env, and priority. */
  readonly inheritance?: SpawnInheritanceConfig;
  /** Iteration limits for the child. */
  readonly limits?: Partial<IterationLimits>;
  /** Loop detection config for the child. Set to false to disable. */
  readonly loopDetection?: Partial<LoopDetectionConfig> | false;
  /** Kernel extensions for the child. */
  readonly extensions?: readonly KernelExtension[];
  /** Process group to assign this child to. Recorded in the registry entry. */
  readonly groupId?: AgentGroupId | undefined;
  /**
   * Grace period in milliseconds for TERM signal.
   * After aborting the abort controller, wait this long before forcing termination.
   * Defaults to 5000ms.
   */
  readonly gracePeriodMs?: number | undefined;
  /**
   * Delivery policy override for this spawn.
   * Takes precedence over manifest.delivery when resolving the effective policy.
   */
  readonly delivery?: DeliveryPolicy | undefined;
  /**
   * Abort signal for cooperative cancellation during slot acquisition.
   * When provided and the ledger supports `acquireOrWait`, the spawn will
   * wait for a slot instead of failing immediately at capacity.
   */
  readonly signal?: AbortSignal | undefined;

  // ---------------------------------------------------------------------------
  // Sub-agent constraints (hook agents, sandboxed spawns)
  // ---------------------------------------------------------------------------

  /** Tool names to exclude from the child's tool set (filters inherited + additional tools). */
  readonly toolDenylist?: readonly string[] | undefined;
  /** Tool names to exclusively allow from inherited parent tools. Mutually exclusive with toolDenylist. Does not filter additionalTools. */
  readonly toolAllowlist?: readonly string[] | undefined;
  /**
   * When true, this is a fork spawn — inherits all parent tools and has
   * `agent_spawn` automatically stripped (recursion guard). Compatible with
   * `toolDenylist` for additional narrowing. `DEFAULT_FORK_MAX_TURNS` is applied
   * when `limits.maxTurns` is not set.
   */
  readonly fork?: true | undefined;
  /** Additional tool descriptors to inject into the child's tool set. */
  readonly additionalTools?: readonly ToolDescriptor[] | undefined;
  /**
   * When true, the child runs non-interactively — approval prompts are
   * auto-denied and AskUser-style tools are stripped. Used by hook agents.
   */
  readonly nonInteractive?: boolean | undefined;
  /**
   * Name of a tool that must be called before the agent can complete.
   * When set, a structured output guard middleware is injected that
   * re-prompts the agent if it tries to finish without calling this tool.
   */
  readonly requiredOutputTool?: string | undefined;
}

/**
 * Result of spawning a child agent.
 * The caller decides whether to run the child synchronously or asynchronously.
 *
 * Named SpawnChildResult to disambiguate from L0's SpawnResult (unified spawn outcome).
 */
export interface SpawnChildResult {
  /** The child's KoiRuntime. Caller invokes `runtime.run()` to start execution. */
  readonly runtime: KoiRuntime;
  /** Lifecycle handle for monitoring the child. Fires events on start/terminate. */
  readonly handle: ChildHandle;
  /** The child's process ID (convenience — also available as runtime.agent.pid). */
  readonly childPid: ProcessId;
  /**
   * Per-child delegated Nexus API key — attenuated credential from parent delegation.
   * Present when delegation uses a Nexus backend (proof.kind === "nexus").
   * Callers spawning external processes (Temporal, sandbox) must pass this key
   * to the child's env as NEXUS_API_KEY. In-process children inherit the
   * parent's DELEGATION component and don't need this directly.
   */
  readonly nexusApiKey?: string;
  /** Delegation ID for this child, if auto-delegation was performed. */
  readonly delegationId?: DelegationId;
}
