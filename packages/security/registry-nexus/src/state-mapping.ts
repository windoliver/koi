/**
 * Bidirectional state mapping between Koi ProcessState and Nexus AgentState.
 *
 * Koi has 6 process states; Nexus has 4 agent states. The mapping is lossy
 * in both directions, so full AgentStatus is stored in Nexus metadata under
 * "koi:status" for lossless round-trip.
 */

import type { AgentStatus, ProcessState } from "@koi/core";

export function mapKoiToNexus(phase: ProcessState): string {
  switch (phase) {
    case "created":
    case "running":
      return "CONNECTED";
    case "waiting":
    case "idle":
      return "IDLE";
    case "suspended":
    case "terminated":
      return "SUSPENDED";
  }
}

const NEXUS_TO_KOI: Readonly<Record<string, ProcessState>> = Object.freeze({
  UNKNOWN: "created",
  CONNECTED: "running",
  IDLE: "waiting",
  SUSPENDED: "suspended",
});

/**
 * Map a Nexus AgentState to a Koi ProcessState.
 *
 * Throws on unknown states rather than silently defaulting — schema drift,
 * a server bug, or a malformed payload should fail closed during hydration
 * so the registry doesn't fabricate a synthetic lifecycle state and
 * misdrive scheduling/cleanup decisions.
 */
export function mapNexusToKoi(
  state: string,
  metadata?: Readonly<Record<string, unknown>>,
): ProcessState {
  if (state === "SUSPENDED" && metadata?.["koi:terminated"] === true) {
    return "terminated";
  }
  const mapped = NEXUS_TO_KOI[state];
  if (mapped === undefined) {
    throw new Error(
      `Unknown Nexus AgentState "${state}" — refuse to fabricate a synthetic Koi phase`,
    );
  }
  return mapped;
}

/** Metadata key used to store the full Koi AgentStatus in Nexus. */
export const KOI_STATUS_KEY = "koi:status" as const;

/** Metadata key used to flag terminated agents in Nexus. */
export const KOI_TERMINATED_KEY = "koi:terminated" as const;

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

const VALID_PHASES: ReadonlySet<string> = new Set([
  "created",
  "running",
  "waiting",
  "idle",
  "suspended",
  "terminated",
]);

/**
 * Decode a `koi:status` metadata blob into an AgentStatus.
 *
 * Strict: rejects unknown phases, non-finite/non-integer numbers, and
 * non-string conditions. Schema drift or a malicious/corrupted remote
 * record must not bleed into local AgentStatus — bad blobs return
 * undefined so the adapter falls back to live Nexus state instead of
 * trusting potentially-poisoned data (e.g. a NaN generation that would
 * make every CAS comparison fail).
 */
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

  if (typeof phase !== "string" || !VALID_PHASES.has(phase)) return undefined;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) {
    return undefined;
  }
  if (!Array.isArray(conditions) || !conditions.every((c) => typeof c === "string")) {
    return undefined;
  }
  if (
    typeof lastTransitionAt !== "number" ||
    !Number.isFinite(lastTransitionAt) ||
    lastTransitionAt < 0
  ) {
    return undefined;
  }

  const reason = obj.reason as AgentStatus["reason"];

  return {
    phase: phase as ProcessState,
    generation,
    conditions: conditions as AgentStatus["conditions"],
    lastTransitionAt,
    ...(reason !== undefined ? { reason } : {}),
  };
}
