/**
 * Vector-clock operations and conflict resolution for federation sync events.
 */

import type {
  ClockOrder,
  ConflictReport,
  ConflictResolutionResult,
  ConflictResolutionStrategy,
  FederationSyncEvent,
  VectorClock,
} from "./types.js";

/** Increment one zone component and return a fresh clock. */
export function incrementVectorClock(clock: VectorClock, zone: string): VectorClock {
  return { ...clock, [zone]: (clock[zone] ?? 0) + 1 };
}

/** Merge two clocks by component-wise maximum. */
export function mergeVectorClock(left: VectorClock, right: VectorClock): VectorClock {
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
      key,
      Math.max(left[key] ?? 0, right[key] ?? 0),
    ]),
  );
}

/** Compare two vector clocks by causal order. */
export function compareVectorClock(left: VectorClock, right: VectorClock): ClockOrder {
  let leftBefore = false;
  let rightBefore = false;

  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const leftValue = left[key] ?? 0;
    const rightValue = right[key] ?? 0;

    if (leftValue < rightValue) {
      leftBefore = true;
    } else if (leftValue > rightValue) {
      rightBefore = true;
    }

    if (leftBefore && rightBefore) return "concurrent";
  }

  if (!leftBefore && !rightBefore) return "equal";
  return leftBefore ? "before" : "after";
}

/** Remove zones whose known activity is older than the supplied cutoff. */
export function pruneVectorClock(
  clock: VectorClock,
  lastActiveTimes: Readonly<Record<string, number>>,
  cutoffAt: number,
): VectorClock {
  return Object.fromEntries(
    Object.entries(clock).filter(([zone]) => {
      const lastActive = lastActiveTimes[zone];
      return lastActive === undefined || lastActive >= cutoffAt;
    }),
  );
}

/** Extract the shared resource key, if an event declares one. */
export function getConflictResourceKey(event: FederationSyncEvent): string | undefined {
  const value = event.data.resourceKey ?? event.data.resource;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True when two events concurrently write the same declared shared resource. */
export function detectEventConflict(
  local: FederationSyncEvent,
  remote: FederationSyncEvent,
): boolean {
  const localResource = getConflictResourceKey(local);
  const remoteResource = getConflictResourceKey(remote);
  if (localResource === undefined || localResource !== remoteResource) return false;
  return compareVectorClock(local.vectorClock ?? {}, remote.vectorClock ?? {}) === "concurrent";
}

/** Resolve a concurrent event conflict using the requested strategy. */
export function resolveEventConflict(
  local: FederationSyncEvent,
  remote: FederationSyncEvent,
  strategy: ConflictResolutionStrategy,
): ConflictResolutionResult {
  const resourceKey = getConflictResourceKey(local) ?? getConflictResourceKey(remote) ?? "";
  const report: ConflictReport = {
    resourceKey,
    order: "concurrent",
    local,
    remote,
    strategy,
  };

  if (strategy === "manual") {
    return { kind: "manual", strategy, report };
  }

  if (strategy === "merge") {
    const winner = pickLastWriter(local, remote);
    return {
      kind: "resolved",
      strategy,
      event: {
        ...winner,
        sequence: Math.max(local.sequence, remote.sequence),
        vectorClock: mergeVectorClock(local.vectorClock ?? {}, remote.vectorClock ?? {}),
        data: { ...local.data, ...remote.data },
        emittedAt: Math.max(local.emittedAt, remote.emittedAt),
      },
    };
  }

  return { kind: "resolved", strategy, event: pickLastWriter(local, remote) };
}

function pickLastWriter(
  local: FederationSyncEvent,
  remote: FederationSyncEvent,
): FederationSyncEvent {
  if (local.emittedAt > remote.emittedAt) return local;
  if (remote.emittedAt > local.emittedAt) return remote;
  return local.originZoneId >= remote.originZoneId ? local : remote;
}
