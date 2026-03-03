/**
 * Bidirectional state mapping between Koi ProcessState and Nexus AgentState.
 *
 * Koi has 5 process states; Nexus has 4 agent states. The mapping is lossy
 * in both directions, so full AgentStatus is stored in Nexus metadata under
 * "koi:status" for lossless round-trip.
 */

import type { AgentStatus, ProcessState } from "@koi/core";

// ---------------------------------------------------------------------------
// Koi → Nexus
// ---------------------------------------------------------------------------

/**
 * Map a Koi ProcessState to the nearest Nexus agent state.
 *
 * Note: "created" maps to "CONNECTED" because Nexus agents start as UNKNOWN
 * and must be transitioned to CONNECTED after registration.
 */
const KOI_TO_NEXUS: Readonly<Record<ProcessState, string>> = Object.freeze({
  created: "CONNECTED",
  running: "CONNECTED",
  waiting: "IDLE",
  suspended: "SUSPENDED",
  terminated: "SUSPENDED",
});

export function mapKoiToNexus(phase: ProcessState): string {
  return KOI_TO_NEXUS[phase];
}

// ---------------------------------------------------------------------------
// Nexus → Koi
// ---------------------------------------------------------------------------

const NEXUS_TO_KOI: Readonly<Record<string, ProcessState>> = Object.freeze({
  UNKNOWN: "created",
  CONNECTED: "running",
  IDLE: "waiting",
  SUSPENDED: "suspended",
});

/**
 * Map a Nexus agent state to the nearest Koi ProcessState.
 *
 * If metadata contains `"koi:terminated": true`, SUSPENDED maps to "terminated"
 * instead of "suspended".
 */
export function mapNexusToKoi(
  state: string,
  metadata?: Readonly<Record<string, unknown>>,
): ProcessState {
  // Check for terminated encoded as SUSPENDED + metadata flag
  if (state === "SUSPENDED" && metadata?.["koi:terminated"] === true) {
    return "terminated";
  }

  const mapped = NEXUS_TO_KOI[state];
  // Default unknown Nexus states to "created"
  return mapped ?? "created";
}

// ---------------------------------------------------------------------------
// AgentStatus ↔ Nexus metadata
// ---------------------------------------------------------------------------

/** Metadata key used to store the full Koi AgentStatus in Nexus. */
export const KOI_STATUS_KEY = "koi:status" as const;

/** Metadata key used to flag terminated agents in Nexus. */
export const KOI_TERMINATED_KEY = "koi:terminated" as const;

/** Encode a full Koi AgentStatus into Nexus metadata fields. */
export function encodeKoiStatus(status: AgentStatus): Readonly<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    [KOI_STATUS_KEY]: {
      phase: status.phase,
      generation: status.generation,
      conditions: status.conditions,
      lastTransitionAt: status.lastTransitionAt,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    },
  };

  if (status.phase === "terminated") {
    base[KOI_TERMINATED_KEY] = true;
  }

  return base;
}

/** Decode a full Koi AgentStatus from Nexus metadata, if present. */
export function decodeKoiStatus(
  metadata: Readonly<Record<string, unknown>>,
): AgentStatus | undefined {
  const raw = metadata[KOI_STATUS_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;

  const obj = raw as Readonly<Record<string, unknown>>;
  const phase = obj.phase;
  const generation = obj.generation;
  const conditions = obj.conditions;
  const lastTransitionAt = obj.lastTransitionAt;

  if (typeof phase !== "string") return undefined;
  if (typeof generation !== "number") return undefined;
  if (!Array.isArray(conditions)) return undefined;
  if (typeof lastTransitionAt !== "number") return undefined;

  const reason = obj.reason as AgentStatus["reason"];

  return {
    phase: phase as ProcessState,
    generation,
    conditions: conditions as AgentStatus["conditions"],
    lastTransitionAt,
    ...(reason !== undefined ? { reason } : {}),
  };
}
