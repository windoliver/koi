import type { SupervisorHealth } from "@koi/core/daemon";
import type { BgSessionRow } from "./types.js";

export interface FreshnessInput {
  readonly row: BgSessionRow;
  readonly health: SupervisorHealth | null;
  readonly locallySpawnedIds: ReadonlySet<string>;
  readonly now: number;
}

const PENDING_GRACE_MS = 30_000;

function freshnessFromHeartbeat(
  workerSnap: NonNullable<SupervisorHealth["workers"][number]>,
  startedAt: number,
  now: number,
): BgSessionRow["freshness"] {
  const last = workerSnap.lastHeartbeatAt ?? null;
  const deadline = workerSnap.heartbeatDeadlineAt ?? null;
  if (deadline === null) return "unmonitored";
  if (last === null) {
    if (now - startedAt < PENDING_GRACE_MS) return "pending";
    return "timeout";
  }
  if (now <= deadline) return "ok";
  const interval = deadline - last;
  if (now - deadline < interval) return "stale";
  return "timeout";
}

export function computeFreshness(input: FreshnessInput): BgSessionRow["freshness"] {
  const { row, health, locallySpawnedIds, now } = input;
  const workerSnap = health?.workers.find((w) => w.workerId === row.workerId);
  if (workerSnap !== undefined) {
    if (workerSnap.state === "quarantined") return "quarantined";
    if (workerSnap.state === "restarting") return "restarting";
    if (workerSnap.state === "stopping") return "stopping";
  }

  if (row.status === "exited" || row.status === "crashed") return "terminal";
  if (row.status === "detached") return "detached";
  if (row.status === "terminating") return "terminating";

  if (row.status === "starting") {
    if (!locallySpawnedIds.has(row.workerId)) return "foreign";
    if (now - row.startedAt < PENDING_GRACE_MS) return "pending";
    return "timeout";
  }

  if (workerSnap === undefined) return "foreign";
  return freshnessFromHeartbeat(workerSnap, row.startedAt, now);
}
