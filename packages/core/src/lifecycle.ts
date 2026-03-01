/**
 * Agent lifecycle contract — registration, state transitions, and monitoring.
 *
 * The 7th core contract alongside Middleware, Message, Channel, Resolver,
 * Assembly, and Engine. Defines the pluggable AgentRegistry interface for
 * agent lifecycle management.
 *
 * Exception: VALID_TRANSITIONS is a pure readonly data constant derived from
 * L0 type definitions, codifying architecture-doc invariants with zero logic.
 */

import type { AgentId, ProcessState } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { ZoneId } from "./zone.js";

// ---------------------------------------------------------------------------
// Agent conditions (Kubernetes-inspired sub-state)
// ---------------------------------------------------------------------------

/**
 * Fine-grained conditions layered beneath ProcessState.
 * Multiple conditions can be active simultaneously.
 */
export type AgentCondition = "Initialized" | "Ready" | "Healthy" | "Draining";

// ---------------------------------------------------------------------------
// Transition reasons
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing why a state transition occurred.
 * Used for audit trails and debugging.
 */
export type TransitionReason =
  | { readonly kind: "assembly_complete" }
  | { readonly kind: "awaiting_response" }
  | { readonly kind: "response_received" }
  | { readonly kind: "hitl_pause" }
  | { readonly kind: "budget_exceeded" }
  | { readonly kind: "governance_block" }
  | { readonly kind: "human_approval" }
  | { readonly kind: "budget_replenished" }
  | { readonly kind: "completed" }
  | { readonly kind: "error"; readonly cause?: unknown }
  | { readonly kind: "iteration_limit" }
  | { readonly kind: "timeout" }
  | { readonly kind: "evicted" }
  | { readonly kind: "stale" }
  | { readonly kind: "restarted"; readonly attempt: number; readonly strategy: string }
  | { readonly kind: "escalated"; readonly cause: string };

// ---------------------------------------------------------------------------
// Valid state transitions (architecture-doc invariants)
// ---------------------------------------------------------------------------

/**
 * Allowed state transitions per Koi architecture doc.
 * L1 engine runtime uses this to validate transitions.
 * L2 packages can import this to check transitions without importing L1.
 *
 * Transitions:
 *   created → running, terminated
 *   running → waiting, suspended, terminated
 *   waiting → running, suspended, terminated
 *   suspended → running, terminated
 *   terminated → (none)
 */
export const VALID_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> =
  Object.freeze({
    created: ["running", "terminated"] as const,
    running: ["waiting", "suspended", "terminated"] as const,
    waiting: ["running", "suspended", "terminated"] as const,
    suspended: ["running", "terminated"] as const,
    terminated: [] as const,
  });

// ---------------------------------------------------------------------------
// Agent status (layered state model)
// ---------------------------------------------------------------------------

/**
 * Rich agent status combining phase, generation counter (CAS),
 * sub-conditions, and transition metadata.
 */
export interface AgentStatus {
  readonly phase: ProcessState;
  /** CAS generation counter. Increments on each state transition. */
  readonly generation: number;
  /** Active conditions — multiple can be true simultaneously. */
  readonly conditions: readonly AgentCondition[];
  /** Why the last transition occurred. */
  readonly reason?: TransitionReason;
  /** Unix timestamp ms of the last state transition. */
  readonly lastTransitionAt: number;
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

/** A registered agent in the lifecycle registry. */
export interface RegistryEntry {
  readonly agentId: AgentId;
  readonly status: AgentStatus;
  readonly agentType: "copilot" | "worker";
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Unix timestamp ms when the agent was registered. */
  readonly registeredAt: number;
  /** Parent agent ID (undefined for root agents). */
  readonly parentId?: AgentId;
  /** Immutable provenance — the agent that spawned this one. Set once at registration, never updated. */
  readonly spawner?: AgentId;
  /** Zone this agent belongs to. Undefined for unzoned agents. */
  readonly zoneId?: ZoneId | undefined;
  /** Runtime priority. 0 = highest, default 10, range [0, 39]. */
  readonly priority: number;
}

// ---------------------------------------------------------------------------
// Patchable fields (for generic registry patch())
// ---------------------------------------------------------------------------

/** Fields that can be updated via AgentRegistry.patch(). */
export interface PatchableRegistryFields {
  readonly priority?: number | undefined;
  readonly zoneId?: ZoneId | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Registry events
// ---------------------------------------------------------------------------

/** Events emitted by the registry on state changes. */
export type RegistryEvent =
  | { readonly kind: "registered"; readonly entry: RegistryEntry }
  | { readonly kind: "deregistered"; readonly agentId: AgentId }
  | {
      readonly kind: "transitioned";
      readonly agentId: AgentId;
      readonly from: ProcessState;
      readonly to: ProcessState;
      readonly generation: number;
      readonly reason: TransitionReason;
    }
  | {
      readonly kind: "patched";
      readonly agentId: AgentId;
      readonly fields: PatchableRegistryFields;
      readonly entry: RegistryEntry;
    };

// ---------------------------------------------------------------------------
// Registry filter
// ---------------------------------------------------------------------------

/** Filter criteria for listing registered agents. */
export interface RegistryFilter {
  readonly phase?: ProcessState;
  readonly agentType?: "copilot" | "worker";
  readonly condition?: AgentCondition;
  /** Filter by parent agent ID. */
  readonly parentId?: AgentId;
  /** Filter by zone ID. */
  readonly zoneId?: ZoneId | undefined;
}

// ---------------------------------------------------------------------------
// Filter matching (pure function)
// ---------------------------------------------------------------------------

/**
 * Check whether a RegistryEntry matches a RegistryFilter.
 *
 * Pure function — no side effects, no I/O. Shared across all AgentRegistry
 * implementations to avoid duplicating filter logic.
 *
 * Exception: Pure function operating only on L0 types, permitted in L0
 * per architecture doc.
 */
export function matchesFilter(entry: RegistryEntry, filter: RegistryFilter): boolean {
  if (filter.phase !== undefined && entry.status.phase !== filter.phase) return false;
  if (filter.agentType !== undefined && entry.agentType !== filter.agentType) return false;
  if (filter.condition !== undefined && !entry.status.conditions.includes(filter.condition)) {
    return false;
  }
  if (filter.parentId !== undefined && entry.parentId !== filter.parentId) return false;
  if (filter.zoneId !== undefined && entry.zoneId !== filter.zoneId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Agent registry (7th L0 contract)
// ---------------------------------------------------------------------------

/**
 * Pluggable agent lifecycle registry. Manages registration, state transitions
 * (with CAS via generation counter), and change notification.
 *
 * All methods return `T | Promise<T>` — in-memory implementations are sync,
 * network-backed implementations (e.g., Nexus) are async.
 */
export interface AgentRegistry extends AsyncDisposable {
  /** Register a new agent. Returns the stored entry. */
  readonly register: (entry: RegistryEntry) => RegistryEntry | Promise<RegistryEntry>;

  /** Remove an agent from the registry. Returns true if found. */
  readonly deregister: (agentId: AgentId) => boolean | Promise<boolean>;

  /** Look up an agent by ID. Returns undefined if not found. */
  readonly lookup: (
    agentId: AgentId,
  ) => RegistryEntry | undefined | Promise<RegistryEntry | undefined>;

  /** List agents matching an optional filter. */
  readonly list: (
    filter?: RegistryFilter,
  ) => readonly RegistryEntry[] | Promise<readonly RegistryEntry[]>;

  /**
   * CAS state transition. Only succeeds if the current generation matches
   * `expectedGeneration`. Returns the updated entry on success, or a
   * CONFLICT/VALIDATION error on failure.
   */
  readonly transition: (
    agentId: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ) => Result<RegistryEntry, KoiError> | Promise<Result<RegistryEntry, KoiError>>;

  /**
   * Generic patch — update mutable fields on a registered agent.
   * Only non-undefined fields are applied (copy-on-write).
   * Returns the updated entry on success, or NOT_FOUND/VALIDATION error.
   */
  readonly patch: (
    agentId: AgentId,
    fields: PatchableRegistryFields,
  ) => Result<RegistryEntry, KoiError> | Promise<Result<RegistryEntry, KoiError>>;

  /** Subscribe to registry change events. Returns unsubscribe function. */
  readonly watch: (listener: (event: RegistryEvent) => void) => () => void;
}
