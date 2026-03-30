/**
 * ECS compositional layer — Agent (entity), SubsystemToken (component key),
 * Tool, ComponentProvider, and singleton component types.
 *
 * Exception: branded type constructors (identity casts for SubsystemToken<T>)
 * are permitted in L0 as they are zero-logic operations that exist purely for
 * type safety.
 */

import type { AgentManifest } from "./assembly.js";
import type { BrickRegistryReader } from "./brick-registry.js";
import type { BrickRequires } from "./brick-store.js";
import type { BrowserDriver } from "./browser-driver.js";
import type { ChannelAdapter } from "./channel.js";
import type { JsonObject } from "./common.js";
import type { DelegationComponent } from "./delegation.js";
import type { TerminationOutcome } from "./engine.js";
import type { ExternalAgentDescriptor } from "./external-agent.js";
import type { FileSystemBackend } from "./filesystem-backend.js";
import type { GovernanceController } from "./governance.js";
import type { GovernanceBackend } from "./governance-backend.js";
import type { HandoffComponent } from "./handoff.js";
import type { InboxComponent } from "./inbox.js";
import type { MailboxComponent } from "./mailbox.js";
import type { NameServiceReader } from "./name-service.js";
import type { ReputationBackend } from "./reputation-backend.js";
import type { SchedulerComponent } from "./scheduler.js";
import type { ScratchpadComponent } from "./scratchpad.js";
import type { SkillRegistryReader } from "./skill-registry.js";
import type { VersionIndexReader } from "./version-index.js";
import type { WebhookComponent } from "./webhook.js";
import type { WorkspaceInfo } from "./workspace.js";
import type { ZoneRegistry } from "./zone.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;

export type SubsystemToken<T> = string & {
  readonly [__brand]: T;
};

declare const __groupBrand: unique symbol;

/**
 * Branded string type for agent group identifiers.
 * Groups are runtime constructs — assigned at spawn time, not in the manifest.
 */
export type AgentGroupId = string & { readonly [__groupBrand]: "AgentGroupId" };

/** Create a branded AgentGroupId from a plain string. */
export function agentGroupId(id: string): AgentGroupId {
  return id as AgentGroupId;
}

// ---------------------------------------------------------------------------
// Signal vocabulary
// ---------------------------------------------------------------------------

/**
 * Typed signal vocabulary for agent lifecycle control.
 * Mirrors POSIX process signals — STOP/CONT for suspension, TERM for graceful
 * shutdown, USR1/USR2 for application-defined semantics.
 */
export const AGENT_SIGNALS = {
  /** Pause agent at next turn boundary → transitions to "suspended". */
  STOP: "stop",
  /** Resume a suspended agent → transitions to "running". */
  CONT: "cont",
  /** Graceful shutdown — aborts current work then terminates. */
  TERM: "term",
  /** Application-defined signal 1 (fires notify only, no state change). */
  USR1: "usr1",
  /** Application-defined signal 2 (fires notify only, no state change). */
  USR2: "usr2",
} as const;

/** Union of the well-known signal strings. */
export type AgentSignal = (typeof AGENT_SIGNALS)[keyof typeof AGENT_SIGNALS];

declare const __agentBrand: unique symbol;

/**
 * Branded string type for agent identifiers.
 * Prevents accidental mixing with session IDs, delegation IDs, etc.
 */
export type AgentId = string & { readonly [__agentBrand]: "AgentId" };

declare const __sessionBrand: unique symbol;

/** Branded string type for session identifiers. */
export type SessionId = string & { readonly [__sessionBrand]: "SessionId" };

declare const __runBrand: unique symbol;

/** Branded string type for run identifiers (one per run() invocation). */
export type RunId = string & { readonly [__runBrand]: "RunId" };

declare const __turnBrand: unique symbol;

/** Branded string type for turn identifiers. Hierarchical: `${runId}:t${turnIndex}`. */
export type TurnId = string & { readonly [__turnBrand]: "TurnId" };

declare const __toolCallBrand: unique symbol;

/** Branded string type for tool call identifiers. */
export type ToolCallId = string & { readonly [__toolCallBrand]: "ToolCallId" };

// ---------------------------------------------------------------------------
// Token & ID factories (branded casts — sole runtime code in L0)
// ---------------------------------------------------------------------------

export function token<T>(name: string): SubsystemToken<T> {
  return name as SubsystemToken<T>;
}

export function toolToken(name: string): SubsystemToken<Tool> {
  return `tool:${name}` as SubsystemToken<Tool>;
}

export function channelToken(name: string): SubsystemToken<ChannelAdapter> {
  return `channel:${name}` as SubsystemToken<ChannelAdapter>;
}

export function skillToken(name: string): SubsystemToken<SkillMetadata> {
  return `skill:${name}` as SubsystemToken<SkillMetadata>;
}

export function middlewareToken(name: string): SubsystemToken<unknown> {
  return `middleware:${name}` as SubsystemToken<unknown>;
}

export function agentToken(name: string): SubsystemToken<AgentDescriptor> {
  return `agent:${name}` as SubsystemToken<AgentDescriptor>;
}

/** Create a branded AgentId from a plain string. */
export function agentId(id: string): AgentId {
  return id as AgentId;
}

/** Create a branded SessionId from a plain string. */
export function sessionId(id: string): SessionId {
  return id as SessionId;
}

/** Create a branded RunId from a plain string. */
export function runId(id: string): RunId {
  return id as RunId;
}

/** Create a branded TurnId from a RunId and turn index. Hierarchical: `${runId}:t${turnIndex}`. */
export function turnId(run: RunId, turnIndex: number): TurnId {
  return `${run}:t${turnIndex}` as TurnId;
}

/** Create a branded ToolCallId from a plain string. */
export function toolCallId(id: string): ToolCallId {
  return id as ToolCallId;
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

export type ProcessState = "created" | "running" | "waiting" | "suspended" | "idle" | "terminated";

export interface ProcessId {
  readonly id: AgentId;
  readonly name: string;
  readonly type: "copilot" | "worker";
  readonly depth: number;
  readonly parent?: AgentId;
  /** External user/system identity that owns this agent process. */
  readonly ownerId?: string | undefined;
  /** Process group this agent belongs to. Assigned at spawn time, not in the manifest. */
  readonly groupId?: AgentGroupId | undefined;
}

// ---------------------------------------------------------------------------
// Agent (ECS entity)
// ---------------------------------------------------------------------------

export interface Agent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;
  readonly state: ProcessState;
  /**
   * Termination outcome — defined only when `state === "terminated"`.
   * Maps the engine's stop reason to a coarse success/error/interrupted
   * signal so L2 consumers (e.g., workspace cleanup) can distinguish
   * normal completion from failure without depending on L1 internals.
   *
   * `undefined` on a terminated agent means the outcome is unknown —
   * consumers should fail-closed (treat as NOT success).
   */
  readonly terminationOutcome?: TerminationOutcome | undefined;
  readonly component: <T>(token: SubsystemToken<T>) => T | undefined;
  readonly has: (token: SubsystemToken<unknown>) => boolean;
  readonly hasAll: (...tokens: readonly SubsystemToken<unknown>[]) => boolean;
  readonly query: <T>(prefix: string) => ReadonlyMap<SubsystemToken<T>, T>;
  /**
   * Returns all attached components as a readonly map.
   * Implementations SHOULD return a stable reference (not a copy)
   * to avoid O(n) allocation on every call. This is a hot path
   * during middleware execution.
   */
  readonly components: () => ReadonlyMap<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool origin — where a tool came from
// ---------------------------------------------------------------------------

/** How a tool entered the system: bundled at build time, operator-installed, or agent-forged. */
export type ToolOrigin = "primordial" | "operator" | "forged";

// ---------------------------------------------------------------------------
// Tool capabilities — capability-based policy
// ---------------------------------------------------------------------------

/** Network access capability — deny-by-default, allow specific hosts. */
export interface NetworkCapability {
  readonly allow: boolean;
  readonly hosts?: readonly string[];
}

/** Filesystem access capability — read/write path allowlists. */
export interface FilesystemCapability {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
}

/** OS-level resource limits for sandboxed execution. */
export interface ResourceCapability {
  readonly maxMemoryMb?: number;
  readonly timeoutMs?: number;
  readonly maxPids?: number;
  readonly maxOpenFiles?: number;
}

/** Declared capabilities for a tool — what it is allowed to access. */
export interface ToolCapabilities {
  readonly network?: NetworkCapability;
  readonly filesystem?: FilesystemCapability;
  readonly resources?: ResourceCapability;
}

/** Policy controlling how a tool executes: sandbox isolation + declared capabilities. */
export interface ToolPolicy {
  readonly sandbox: boolean;
  readonly capabilities: ToolCapabilities;
}

// ---------------------------------------------------------------------------
// Default tool policies (L0 exception: pure readonly data constants)
// ---------------------------------------------------------------------------

/** Default policy for sandboxed tools — no network, limited filesystem, resource caps. */
export const DEFAULT_SANDBOXED_POLICY: ToolPolicy = {
  sandbox: true,
  capabilities: {
    network: { allow: false },
    filesystem: { read: ["/usr", "/bin", "/lib", "/etc", "/tmp"], write: ["/tmp/koi-sandbox-*"] },
    resources: { maxMemoryMb: 512, timeoutMs: 30_000, maxPids: 64, maxOpenFiles: 256 },
  },
} as const;

/** Default policy for unsandboxed tools — no restrictions. */
export const DEFAULT_UNSANDBOXED_POLICY: ToolPolicy = {
  sandbox: false,
  capabilities: {},
} as const;

// ---------------------------------------------------------------------------
// Tool & Skill
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly tags?: readonly string[];
  /** How this tool entered the system. Absent for legacy callers (treated as "primordial"). */
  readonly origin?: ToolOrigin;
}

/**
 * Lightweight tool summary for progressive disclosure (~20 tokens).
 * Contains only name + description — enough for the model to know a tool
 * exists without loading the full inputSchema.
 */
export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

/** Options bag for Tool.execute — extensible without breaking existing callers. */
export interface ToolExecuteOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly origin: ToolOrigin;
  readonly policy: ToolPolicy;
  readonly execute: (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool registration — self-describing L2 tool packages
// ---------------------------------------------------------------------------

/** Read-only environment accessor for availability checks. */
export type EnvReader = Readonly<Record<string, string | undefined>>;

/**
 * Factory descriptor for a single tool within a ToolRegistration.
 * L2 packages export one ToolFactory per tool they provide.
 */
export interface ToolFactory {
  /** Tool name — must match the name used in ToolDescriptor and manifest ToolConfig. */
  readonly name: string;
  /** Create the Tool instance. Receives the agent entity and optional per-tool config. */
  readonly create: (agent: Agent, options?: JsonObject) => Tool | Promise<Tool>;
}

/**
 * Self-describing registration descriptor exported by L2 tool packages.
 *
 * Each L2 package exports a `registration` const satisfying this type.
 * The engine discovers registrations via the manifest `package` field
 * and auto-wires ComponentProviders during assembly.
 */
export interface ToolRegistration {
  /** Human-readable provider name (used in conflict diagnostics). */
  readonly name: string;
  /** Tool factories — one per tool this package provides. */
  readonly tools: readonly ToolFactory[];
  /**
   * Availability gate. Returns true when the tools can be used.
   * Receives a read-only env snapshot (defaults to `process.env`).
   * When absent, tools are always available.
   * Fail-closed: if the check throws, tools are treated as unavailable.
   */
  readonly checkAvailability?: (env: EnvReader) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Toolset tag convention — categorize tools via tags
// ---------------------------------------------------------------------------

/**
 * Well-known toolset tag prefixes for tool categorization.
 * Convention: use `toolset:<category>` as a tag value on ToolDescriptor.
 *
 * Example: `tags: ["toolset:scheduling"]` on a scheduler tool descriptor.
 */
export const TOOLSET_TAGS = {
  /** Scheduling, task management, cron jobs */
  SCHEDULING: "toolset:scheduling",
  /** Code forging, brick creation, self-extension */
  FORGE: "toolset:forge",
  /** Web fetch, search, API calls */
  WEB: "toolset:web",
  /** GitHub PR lifecycle, CI */
  GITHUB: "toolset:github",
  /** Capability discovery and catalog search */
  CATALOG: "toolset:catalog",
  /** User interaction, elicitation, approval */
  INTERACTION: "toolset:interaction",
  /** Context retrieval, documentation lookup */
  CONTEXT: "toolset:context",
  /** Memory store, recall, search */
  MEMORY: "toolset:memory",
  /** Filesystem read, write, edit, search */
  FILESYSTEM: "toolset:filesystem",
  /** Observability, audit, monitoring */
  OBSERVABILITY: "toolset:observability",
} as const;

/** Union type of all well-known toolset tags. */
export type ToolsetTag = (typeof TOOLSET_TAGS)[keyof typeof TOOLSET_TAGS];

/** Type guard: returns true if a tag string is a toolset tag (starts with "toolset:"). */
export function isToolsetTag(tag: string): boolean {
  return tag.startsWith("toolset:");
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

/**
 * Rich skill component attached by forge. Extends SkillMetadata with content.
 * ForgeComponentProvider stores this; consumers query<SkillComponent>("skill:").
 */
export interface SkillComponent extends SkillMetadata {
  readonly content: string;
  readonly requires?: BrickRequires;
}

/**
 * A skill definition bundled with a BrickDescriptor to teach the LLM
 * when and how to use this brick. Auto-injected into copilot context
 * so the model can make informed engine/adapter selection decisions.
 */
export interface CompanionSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly tags?: readonly string[];
}

/**
 * Lightweight agent descriptor for peer discovery.
 * Raw manifestYaml — consumers parse when needed (lazy philosophy).
 */
export interface AgentDescriptor {
  readonly name: string;
  readonly description: string;
  readonly manifestYaml: string;
}

// ---------------------------------------------------------------------------
// Component provider
// ---------------------------------------------------------------------------

/** A component that was skipped during attach with a human-readable reason. */
export interface SkippedComponent {
  readonly name: string;
  readonly reason: string;
}

/** Rich result from ComponentProvider.attach() with skip reporting. */
export interface AttachResult {
  readonly components: ReadonlyMap<string, unknown>;
  readonly skipped: readonly SkippedComponent[];
}

/** Type guard: returns true when value is an AttachResult (not a bare ReadonlyMap). */
export function isAttachResult(
  value: AttachResult | ReadonlyMap<string, unknown>,
): value is AttachResult {
  return typeof value === "object" && value !== null && "components" in value && "skipped" in value;
}

export interface ComponentProvider {
  readonly name: string;
  /**
   * Assembly priority. Lower = higher precedence.
   * When multiple providers supply the same component key,
   * the provider with the lowest priority wins (first-write-wins after sort).
   * Defaults to COMPONENT_PRIORITY.BUNDLED (100) if omitted.
   */
  readonly priority?: number;
  /**
   * Attach components to an agent. Returns either a bare ReadonlyMap (legacy)
   * or an AttachResult with skip reporting. Use isAttachResult() to discriminate.
   */
  readonly attach: (agent: Agent) => Promise<AttachResult | ReadonlyMap<string, unknown>>;
  readonly detach?: (agent: Agent) => Promise<void>;
  readonly watch?: (listener: (event: ComponentEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Component priority constants
// ---------------------------------------------------------------------------

/**
 * Priority tiers for ComponentProvider resolution.
 * Lower number = higher precedence.
 * Order: Agent-forged > Zone-forged > Global-forged > Bundled.
 */
export const COMPONENT_PRIORITY: Readonly<{
  readonly AGENT_FORGED: 0;
  readonly ZONE_FORGED: 10;
  readonly GLOBAL_FORGED: 50;
  readonly BUNDLED: 100;
}> = Object.freeze({
  AGENT_FORGED: 0,
  ZONE_FORGED: 10,
  GLOBAL_FORGED: 50,
  BUNDLED: 100,
} as const);

// ---------------------------------------------------------------------------
// Component events
// ---------------------------------------------------------------------------

export type ComponentEventKind = "attached" | "detached";

export interface ComponentEvent {
  readonly kind: ComponentEventKind;
  readonly agentId: AgentId;
  readonly componentKey: string;
}

// ---------------------------------------------------------------------------
// Singleton component types (sub-types deferred to L2)
// ---------------------------------------------------------------------------

/** Memory temperature tier for decay-based prioritization. */
export type MemoryTier = "hot" | "warm" | "cold";

/** A single memory recall result with content and optional metadata. */
export interface MemoryResult {
  readonly content: string;
  readonly score?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Temperature tier — backends that support tiering populate this. */
  readonly tier?: MemoryTier | undefined;
  /** Current decay factor in [0.0, 1.0] — 1.0 = no decay, 0.0 = fully decayed. */
  readonly decayScore?: number | undefined;
  /** ISO-8601 timestamp of last access — used by decay engine. */
  readonly lastAccessed?: string | undefined;
  /** IDs of facts that causally precede this memory (causal parents). */
  readonly causalParents?: readonly string[] | undefined;
  /** IDs of facts that were causally derived from this memory (causal children). */
  readonly causalChildren?: readonly string[] | undefined;
}

/** Options for MemoryComponent.store() — namespace isolation and tagging. */
export interface MemoryStoreOptions {
  readonly namespace?: string;
  readonly tags?: readonly string[];
  /** Semantic category for fact classification (e.g., "milestone", "preference"). */
  readonly category?: string | undefined;
  /** Entity IDs this memory relates to — enables graph-aware retrieval. */
  readonly relatedEntities?: readonly string[] | undefined;
  /** When true and a near-duplicate exists, increment its accessCount instead of skipping. */
  readonly reinforce?: boolean | undefined;
  /** IDs of existing facts that causally precede this new memory. */
  readonly causalParents?: readonly string[] | undefined;
  /** IDs of existing facts to explicitly supersede when storing this fact. */
  readonly supersedes?: readonly string[] | undefined;
}

/** Options for MemoryComponent.recall() — namespace isolation. */
export interface MemoryRecallOptions {
  readonly namespace?: string;
  /** Filter results by temperature tier. Omit or "all" to include all tiers. */
  readonly tierFilter?: MemoryTier | "all" | undefined;
  /** Maximum number of results to return. Backend-specific default if omitted. */
  readonly limit?: number | undefined;
  /** When true, expand results along causal edges (parents + children). */
  readonly graphExpand?: boolean | undefined;
  /** Maximum BFS hops for graph expansion. Backend-specific default if omitted. */
  readonly maxHops?: number | undefined;
}

export interface MemoryComponent {
  readonly recall: (
    query: string,
    options?: MemoryRecallOptions,
  ) => Promise<readonly MemoryResult[]>;
  readonly store: (content: string, options?: MemoryStoreOptions) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Spawn ledger (tree-wide spawn accounting)
// ---------------------------------------------------------------------------

/**
 * SpawnLedger — tree-wide spawn accounting for concurrency governance.
 *
 * Tracks active agent processes across an entire spawn tree.
 * The root agent creates a ledger and passes it down to children via
 * engine options. All agents in the tree share the same ledger instance.
 *
 * Implementations range from in-memory counters (single-Node) to
 * distributed backends (multi-Node via EventComponent, Redis, etc.).
 *
 * acquire/release support `T | Promise<T>` return types so that
 * implementations can be sync (in-memory) or async (network) without
 * interface changes. Callers must always `await` the result.
 */
export interface SpawnLedger {
  /**
   * Attempt to reserve a spawn slot.
   * Returns `true` if a slot was acquired, `false` if at capacity.
   *
   * Callers MUST call `release()` if the spawn subsequently fails,
   * to avoid permanently leaking slots (optimistic locking pattern).
   */
  readonly acquire: () => boolean | Promise<boolean>;

  /**
   * Release a previously acquired spawn slot.
   * Called when a child agent terminates or when a spawn fails
   * after a successful `acquire()`.
   */
  readonly release: () => void | Promise<void>;

  /**
   * Current number of active (acquired but not released) slots.
   * Sync — distributed implementations should cache locally.
   */
  readonly activeCount: () => number;

  /**
   * Maximum number of slots (total capacity).
   * Immutable after creation.
   */
  readonly capacity: () => number;
}

/**
 * WorkspaceComponent is the ECS component type for workspace isolation.
 * Aliased from WorkspaceInfo (the backend creation result) for backward compat.
 */
export type WorkspaceComponent = WorkspaceInfo;

export interface CredentialComponent {
  readonly get: (key: string) => Promise<string | undefined>;
}

export interface EventComponent {
  readonly emit: (type: string, data: unknown) => Promise<void>;
  readonly on: (type: string, handler: (data: unknown) => void) => () => void;
}

/** Read-only registry facade for agent-facing tools to query bricks, skills, and versions. */
export interface RegistryComponent {
  readonly bricks: BrickRegistryReader;
  readonly skills: SkillRegistryReader;
  readonly versions: VersionIndexReader;
}

// ---------------------------------------------------------------------------
// Process accounting
// ---------------------------------------------------------------------------

/** Shared process accounter for cross-agent spawn accounting. */
export interface ProcessAccounter {
  /** Current number of active processes. */
  readonly activeCount: () => number;
  /** Manually increment the active count (e.g., on successful spawn). */
  readonly increment: () => void;
  /** Manually decrement the active count (e.g., on agent termination). */
  readonly decrement: () => void;
}

// ---------------------------------------------------------------------------
// Child lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle event for a child agent. */
export type ChildLifecycleEvent =
  | { readonly kind: "started"; readonly childId: AgentId }
  | { readonly kind: "completed"; readonly childId: AgentId; readonly exitCode: number }
  | { readonly kind: "error"; readonly childId: AgentId; readonly cause?: unknown }
  | { readonly kind: "signaled"; readonly childId: AgentId; readonly signal: string }
  | { readonly kind: "idled"; readonly childId: AgentId }
  | { readonly kind: "woke"; readonly childId: AgentId }
  | { readonly kind: "terminated"; readonly childId: AgentId; readonly exitCode: number };

/** Handle for monitoring and controlling a child agent's lifecycle. */
export interface ChildHandle {
  readonly childId: AgentId;
  readonly name: string;
  readonly onEvent: (listener: (event: ChildLifecycleEvent) => void) => () => void;
  /** Send a named signal to the child. Fires a "signaled" event to listeners. */
  readonly signal: (kind: string) => void | Promise<void>;
  /** Terminate the child agent. No-op if already terminated. Retries once on CAS conflict. */
  readonly terminate: (reason?: string) => void | Promise<void>;
  /** Wait for the child to reach "terminated" phase and return its exit code. */
  readonly waitForCompletion: () => Promise<import("./lifecycle.js").ChildCompletionResult>;
}

// ---------------------------------------------------------------------------
// Well-known singleton tokens
// ---------------------------------------------------------------------------

export const MEMORY: SubsystemToken<MemoryComponent> = token<MemoryComponent>("memory");
export const GOVERNANCE: SubsystemToken<GovernanceController> =
  token<GovernanceController>("governance");
export const GOVERNANCE_BACKEND: SubsystemToken<GovernanceBackend> =
  token<GovernanceBackend>("governance-backend");
export const CREDENTIALS: SubsystemToken<CredentialComponent> =
  token<CredentialComponent>("credentials");
export const EVENTS: SubsystemToken<EventComponent> = token<EventComponent>("events");
export const DELEGATION: SubsystemToken<DelegationComponent> =
  token<DelegationComponent>("delegation");
export const HANDOFF: SubsystemToken<HandoffComponent> = token<HandoffComponent>("handoff");
export const FILESYSTEM: SubsystemToken<FileSystemBackend> = token<FileSystemBackend>("filesystem");
export const BROWSER: SubsystemToken<BrowserDriver> = token<BrowserDriver>("browser");
export const WORKSPACE: SubsystemToken<WorkspaceComponent> = token<WorkspaceComponent>("workspace");
export const SCHEDULER: SubsystemToken<SchedulerComponent> = token<SchedulerComponent>("scheduler");
export const WEBHOOK: SubsystemToken<WebhookComponent> = token<WebhookComponent>("webhook");
export const EXTERNAL_AGENTS: SubsystemToken<readonly ExternalAgentDescriptor[]> =
  token<readonly ExternalAgentDescriptor[]>("external-agents");
export const REGISTRY: SubsystemToken<RegistryComponent> = token<RegistryComponent>("registry");
export const REPUTATION: SubsystemToken<ReputationBackend> = token<ReputationBackend>("reputation");
export const MAILBOX: SubsystemToken<MailboxComponent> = token<MailboxComponent>("mailbox");
export const SCRATCHPAD: SubsystemToken<ScratchpadComponent> =
  token<ScratchpadComponent>("scratchpad");
export const NAME_SERVICE: SubsystemToken<NameServiceReader> =
  token<NameServiceReader>("name-service");
export const ZONE_REGISTRY: SubsystemToken<ZoneRegistry> = token<ZoneRegistry>("zone-registry");
export const INBOX: SubsystemToken<InboxComponent> = token<InboxComponent>("inbox");
export const USER_MODEL: SubsystemToken<import("./user-model.js").UserModelComponent> =
  token<import("./user-model.js").UserModelComponent>("user-model");
export const DATA_SOURCES: SubsystemToken<
  readonly import("./data-source.js").DataSourceDescriptor[]
> = token<readonly import("./data-source.js").DataSourceDescriptor[]>("data_sources");

// ---------------------------------------------------------------------------
// Agent environment (inheritable key-value env down the spawn tree)
// ---------------------------------------------------------------------------

/** Inheritable key-value environment passed down the spawn tree. */
export interface AgentEnv {
  readonly values: Readonly<Record<string, string>>;
  /** Reference to parent env — provenance tracking only, not used for lookups. */
  readonly parentEnv?: AgentEnv | undefined;
}

export const ENV: SubsystemToken<AgentEnv> = token<AgentEnv>("env");
