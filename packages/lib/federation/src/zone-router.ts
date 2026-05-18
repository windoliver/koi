/**
 * Zone-aware routing primitives for federation.
 */

import type { JsonObject, ZoneId, ZoneStatus } from "@koi/core";

/** Health and routing signal for a candidate zone. */
export interface ZoneRouteCandidate {
  readonly zoneId: ZoneId;
  readonly status: ZoneStatus;
  readonly latencyMs: number;
  readonly load?: number | undefined;
}

/** Request context passed to zone routers. */
export interface ZoneRouteRequest {
  readonly toolId: string;
  readonly input?: JsonObject | undefined;
}

/** Mutable health monitor used by tests and in-memory deployments. */
export interface StaticZoneHealthMonitor {
  readonly listHealth: () => readonly ZoneRouteCandidate[];
  readonly getHealth: (zoneId: ZoneId) => ZoneRouteCandidate | undefined;
  readonly setHealth: (zoneId: ZoneId, health: Omit<ZoneRouteCandidate, "zoneId">) => void;
}

/** Selects the best zone for a federated request. */
export interface ZoneRouter {
  readonly selectZone: (request: ZoneRouteRequest) => ZoneRouteCandidate | undefined;
}

/** Create an in-memory health monitor for zone routing. */
export function createStaticZoneHealthMonitor(
  initial: readonly ZoneRouteCandidate[],
): StaticZoneHealthMonitor {
  const health = new Map<string, ZoneRouteCandidate>(
    initial.map((candidate) => [candidate.zoneId, candidate]),
  );

  return {
    listHealth: () => [...health.values()],
    getHealth: (id) => health.get(id),
    setHealth: (id, next) => {
      health.set(id, { zoneId: id, ...next });
    },
  };
}

/** Select the nearest active zone, using load and id as deterministic tie-breakers. */
export function pickHealthyZone(
  candidates: readonly ZoneRouteCandidate[],
): ZoneRouteCandidate | undefined {
  const healthy = candidates.filter(
    (candidate) =>
      candidate.status === "active" &&
      Number.isFinite(candidate.latencyMs) &&
      candidate.latencyMs >= 0,
  );
  const sorted = healthy.toSorted(compareCandidates);
  return sorted[0];
}

/** Create a router backed by a live health monitor. */
export function createZoneRouter(config: {
  readonly monitor: Pick<StaticZoneHealthMonitor, "listHealth">;
}): ZoneRouter {
  return {
    selectZone: () => pickHealthyZone(config.monitor.listHealth()),
  };
}

function compareCandidates(a: ZoneRouteCandidate, b: ZoneRouteCandidate): number {
  const latencyDelta = a.latencyMs - b.latencyMs;
  if (latencyDelta !== 0) return latencyDelta;

  const loadDelta = (a.load ?? 0) - (b.load ?? 0);
  if (loadDelta !== 0) return loadDelta;

  return a.zoneId.localeCompare(b.zoneId);
}
