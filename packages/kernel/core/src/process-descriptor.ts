/**
 * ProcessDescriptor — read-only snapshot of an agent's process state.
 *
 * Composite view derived from RegistryEntry, designed for procfs and
 * monitoring consumers that need a consistent snapshot without importing
 * the full registry internals.
 *
 * Exception: mapRegistryEntryToDescriptor is a pure function operating
 * only on L0 types, permitted in L0 per architecture doc.
 */

import type { AgentId, ProcessState } from "./ecs.js";
import type { TerminationOutcome } from "./engine.js";
import type { AgentCondition, RegistryEntry, TransitionReason } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// ProcessDescriptor
// ---------------------------------------------------------------------------

export interface ProcessDescriptor {
  readonly agentId: AgentId;
  readonly state: ProcessState;
  readonly conditions: readonly AgentCondition[];
  readonly generation: number;
  readonly registeredAt: number;
  readonly terminationOutcome?: TerminationOutcome | undefined;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Derive a TerminationOutcome from a TransitionReason.
 *
 * Only meaningful when the agent is in "terminated" state.
 * Maps reason kinds to the coarse success/error/interrupted signal.
 */
function mapReasonToOutcome(reason: TransitionReason | undefined): TerminationOutcome | undefined {
  if (reason === undefined) return undefined;

  switch (reason.kind) {
    case "completed":
      return "success";
    case "error":
    case "budget_exceeded":
    case "iteration_limit":
    case "escalated":
      return "error";
    case "timeout":
    case "evicted":
    case "stale":
    case "signal_stop":
      return "interrupted";
    // Non-terminal reasons — no termination outcome
    case "assembly_complete":
    case "awaiting_response":
    case "response_received":
    case "hitl_pause":
    case "governance_block":
    case "human_approval":
    case "budget_replenished":
    case "restarted":
    case "signal_cont":
      return undefined;
  }
}

/**
 * Map a RegistryEntry to a read-only ProcessDescriptor snapshot.
 *
 * Pure function — no side effects, no I/O.
 */
export function mapRegistryEntryToDescriptor(entry: RegistryEntry): ProcessDescriptor {
  const terminationOutcome =
    entry.status.phase === "terminated" ? mapReasonToOutcome(entry.status.reason) : undefined;

  return {
    agentId: entry.agentId,
    state: entry.status.phase,
    conditions: entry.status.conditions,
    generation: entry.status.generation,
    registeredAt: entry.registeredAt,
    terminationOutcome,
  };
}
