/**
 * ECS compositional layer — Agent (entity), SubsystemToken (component key),
 * Tool, ComponentProvider, and singleton component types.
 *
 * Exception: branded type constructors (identity casts for SubsystemToken<T>)
 * are permitted in L0 as they are zero-logic operations that exist purely for
 * type safety.
 */

import type { AgentManifest } from "./assembly.js";
import type { ChannelAdapter } from "./channel.js";
import type { JsonObject } from "./common.js";
import type { DelegationComponent } from "./delegation.js";
import type { FileSystemBackend } from "./filesystem-backend.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;

export type SubsystemToken<T> = string & {
  readonly [__brand]: T;
};

declare const __agentBrand: unique symbol;

/**
 * Branded string type for agent identifiers.
 * Prevents accidental mixing with session IDs, delegation IDs, etc.
 */
export type AgentId = string & { readonly [__agentBrand]: "AgentId" };

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

/** Create a branded AgentId from a plain string. */
export function agentId(id: string): AgentId {
  return id as AgentId;
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

export type ProcessState = "created" | "running" | "waiting" | "suspended" | "terminated";

export interface ProcessId {
  readonly id: AgentId;
  readonly name: string;
  readonly type: "copilot" | "worker";
  readonly depth: number;
  readonly parent?: AgentId;
}

// ---------------------------------------------------------------------------
// Agent (ECS entity)
// ---------------------------------------------------------------------------

export interface Agent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;
  readonly state: ProcessState;
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
// Trust tiers
// ---------------------------------------------------------------------------

export type TrustTier = "sandbox" | "verified" | "promoted";

// ---------------------------------------------------------------------------
// Tool & Skill
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly trustTier: TrustTier;
  readonly execute: (args: JsonObject) => Promise<unknown>;
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

// ---------------------------------------------------------------------------
// Component provider
// ---------------------------------------------------------------------------

export interface ComponentProvider {
  readonly name: string;
  readonly attach: (agent: Agent) => Promise<ReadonlyMap<string, unknown>>;
  readonly detach?: (agent: Agent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Singleton component types (sub-types deferred to L2)
// ---------------------------------------------------------------------------

/** A single memory recall result with content and optional metadata. */
export interface MemoryResult {
  readonly content: string;
  readonly score?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryComponent {
  readonly recall: (query: string) => Promise<readonly MemoryResult[]>;
  readonly store: (content: string) => Promise<void>;
}

export interface GovernanceUsage {
  readonly turns: number;
  readonly spawns: number;
  /** Extensible counters for L2-defined metrics (e.g., tokens, tool calls). */
  readonly counters?: Readonly<Record<string, number>>;
}

export type SpawnCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface GovernanceComponent {
  readonly usage: () => GovernanceUsage;
  readonly checkSpawn: (depth: number) => SpawnCheck;
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

export interface CredentialComponent {
  readonly get: (key: string) => Promise<string | undefined>;
}

export interface EventComponent {
  readonly emit: (type: string, data: unknown) => Promise<void>;
  readonly on: (type: string, handler: (data: unknown) => void) => () => void;
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
  | { readonly kind: "completed"; readonly childId: AgentId }
  | { readonly kind: "error"; readonly childId: AgentId; readonly cause?: unknown }
  | { readonly kind: "terminated"; readonly childId: AgentId };

/** Handle for monitoring a child agent's lifecycle. */
export interface ChildHandle {
  readonly childId: AgentId;
  readonly name: string;
  readonly onEvent: (listener: (event: ChildLifecycleEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Well-known singleton tokens
// ---------------------------------------------------------------------------

export const MEMORY: SubsystemToken<MemoryComponent> = token<MemoryComponent>("memory");
export const GOVERNANCE: SubsystemToken<GovernanceComponent> =
  token<GovernanceComponent>("governance");
export const CREDENTIALS: SubsystemToken<CredentialComponent> =
  token<CredentialComponent>("credentials");
export const EVENTS: SubsystemToken<EventComponent> = token<EventComponent>("events");
export const DELEGATION: SubsystemToken<DelegationComponent> =
  token<DelegationComponent>("delegation");
export const FILESYSTEM: SubsystemToken<FileSystemBackend> = token<FileSystemBackend>("filesystem");
