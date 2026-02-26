/**
 * Agent state events — persisted domain events for event-sourced registry.
 *
 * AgentStateEvent is a discriminated union of all state-change events
 * for an agent's lifecycle. These events are appended to per-agent
 * event streams and folded to derive the current RegistryEntry projection.
 *
 * evolveRegistryEntry is a pure fold function that derives RegistryEntry
 * state from a sequence of AgentStateEvents. Permitted in L0 as a
 * side-effect-free data constructor operating only on L0 types.
 */

import type { AgentId, ProcessState } from "./ecs.js";
import type { AgentCondition, AgentStatus, RegistryEntry, TransitionReason } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Event kind union
// ---------------------------------------------------------------------------

/** String union of all AgentStateEvent kind values. */
export type AgentStateEventKind = "agent_registered" | "agent_transitioned" | "agent_deregistered";

// ---------------------------------------------------------------------------
// AgentStateEvent — discriminated union
// ---------------------------------------------------------------------------

/** An agent was registered in the lifecycle registry. */
export interface AgentRegisteredEvent {
  readonly kind: "agent_registered";
  readonly agentId: AgentId;
  readonly agentType: "copilot" | "worker";
  readonly parentId?: AgentId | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly registeredAt: number;
}

/** An agent transitioned between process states (with CAS generation). */
export interface AgentTransitionedEvent {
  readonly kind: "agent_transitioned";
  readonly agentId: AgentId;
  readonly from: ProcessState;
  readonly to: ProcessState;
  readonly generation: number;
  readonly reason: TransitionReason;
  readonly conditions: readonly AgentCondition[];
  readonly transitionedAt: number;
}

/** An agent was removed from the lifecycle registry. */
export interface AgentDeregisteredEvent {
  readonly kind: "agent_deregistered";
  readonly agentId: AgentId;
  readonly deregisteredAt: number;
}

/** Persisted domain events for agent lifecycle state changes. */
export type AgentStateEvent =
  | AgentRegisteredEvent
  | AgentTransitionedEvent
  | AgentDeregisteredEvent;

// ---------------------------------------------------------------------------
// Initial status constant
// ---------------------------------------------------------------------------

/**
 * Initial AgentStatus for a freshly registered agent.
 * Used as the seed state for the fold function.
 */
const EMPTY_CONDITIONS: readonly AgentCondition[] = Object.freeze([]);

export const INITIAL_AGENT_STATUS: AgentStatus = Object.freeze({
  phase: "created" satisfies ProcessState,
  generation: 0,
  conditions: EMPTY_CONDITIONS,
  lastTransitionAt: 0,
});

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

const VALID_KINDS: ReadonlySet<string> = new Set<AgentStateEventKind>([
  "agent_registered",
  "agent_transitioned",
  "agent_deregistered",
]);

/**
 * Runtime type guard for AgentStateEvent.
 * Validates the `kind` discriminator on an unknown payload.
 */
export function isAgentStateEvent(value: unknown): value is AgentStateEvent {
  if (typeof value !== "object" || value === null) return false;
  return VALID_KINDS.has((value as Readonly<Record<string, unknown>>).kind as string);
}

// ---------------------------------------------------------------------------
// Pure fold function
// ---------------------------------------------------------------------------

/**
 * Pure fold function that derives a RegistryEntry from a sequence of events.
 *
 * Given the current state (or undefined for the first event) and an event,
 * returns the new state. Returns undefined on agent_deregistered (agent
 * removed from projection).
 *
 * This function is deterministic and side-effect-free — the same sequence
 * of events always produces the same final state.
 */
export function evolveRegistryEntry(
  state: RegistryEntry | undefined,
  event: AgentStateEvent,
): RegistryEntry | undefined {
  switch (event.kind) {
    case "agent_registered": {
      const base: RegistryEntry = {
        agentId: event.agentId,
        agentType: event.agentType,
        metadata: event.metadata,
        registeredAt: event.registeredAt,
        status: {
          ...INITIAL_AGENT_STATUS,
          lastTransitionAt: event.registeredAt,
        },
      };
      return event.parentId !== undefined ? { ...base, parentId: event.parentId } : base;
    }

    case "agent_transitioned": {
      if (state === undefined) return undefined;
      return {
        ...state,
        status: {
          phase: event.to,
          generation: event.generation,
          conditions: event.conditions,
          reason: event.reason,
          lastTransitionAt: event.transitionedAt,
        },
      };
    }

    case "agent_deregistered":
      return undefined;
  }
}
