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

import type { AgentGroupId, AgentId, ProcessState } from "./ecs.js";
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
  | { readonly kind: "escalated"; readonly cause: string }
  /** Agent received a STOP signal → transitioning to "suspended". */
  | { readonly kind: "signal_stop" }
  /** Agent received a CONT signal → transitioning from "suspended" to "running". */
  | { readonly kind: "signal_cont" };

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
  /** Process group this agent belongs to. Assigned at spawn time. */
  readonly groupId?: AgentGroupId | undefined;
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
  /** Filter by process group ID. */
  readonly groupId?: AgentGroupId | undefined;
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
  if (filter.groupId !== undefined && entry.groupId !== filter.groupId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Child completion result
// ---------------------------------------------------------------------------

/** Result of waiting for a child agent to complete. */
export interface ChildCompletionResult {
  readonly childId: AgentId;
  readonly exitCode: number;
  readonly reason?: TransitionReason;
}

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

/**
 * Map a TransitionReason to a numeric exit code.
 *
 * Convention:
 *   0 = success (completed, signal_stop/cont — resumed agent that eventually exited ok)
 *   1 = generic error
 *   2 = resource/limit exceeded
 *   3 = timeout
 *   4 = eviction/staleness
 *   126 = escalated (capability error, analagous to "command not executable")
 *   130 = terminated by signal (128 + 2, SIGINT convention)
 *
 * Exception: pure function operating only on L0 types, permitted in L0.
 */
export function exitCodeForTransitionReason(reason: TransitionReason): number {
  switch (reason.kind) {
    case "completed":
    case "signal_stop":
    case "signal_cont":
      return 0;
    case "error":
      return 1;
    case "budget_exceeded":
    case "iteration_limit":
      return 2;
    case "timeout":
      return 3;
    case "evicted":
    case "stale":
      return 4;
    case "escalated":
      return 126;
    default:
      return 1;
  }
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

  /** Subscribe to registry change events. Returns unsubscribe function. */
  readonly watch: (listener: (event: RegistryEvent) => void) => () => void;
}
