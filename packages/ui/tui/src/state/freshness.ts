import type { SupervisorHealth } from "@koi/core/daemon";
import type { BgSessionRow } from "./types.js";

export interface FreshnessInput {
  readonly row: BgSessionRow;
  readonly health: SupervisorHealth | null;
  readonly locallySpawnedIds: ReadonlySet<string>;
  readonly now: number;
}

const PENDING_GRACE_MS = 30_000;

export function computeFreshness(input: FreshnessInput): BgSessionRow["freshness"] {
  const { row, health, locallySpawnedIds, now } = input;

  // Live health state overrides registry's terminal status.
  // Crash-loop case: registry shows `crashed` between events; supervisor
  // is restarting. We surface the live transition.
  const workerSnap = health?.workers.find((w) => w.workerId === row.workerId);
  if (workerSnap !== undefined) {
    if (workerSnap.state === "quarantined") return "quarantined";
    if (workerSnap.state === "restarting") return "restarting";
    if (workerSnap.state === "stopping") return "stopping";
    // workerSnap.state === "running" → fall through to registry-based logic
  }

  // No live health override; honor registry status.
  if (row.status === "exited" || row.status === "crashed") return "terminal";
  if (row.status === "detached") return "detached";
  if (row.status === "terminating") return "terminating";

  // status is "starting" or "running" → ownership FIRST, then freshness.
  // Misclassifying a foreign worker as local pending/timeout is a
  // trust-boundary bug — operators see another process's startup as
  // their own health failure.

  if (row.status === "starting") {
    // WorkerHealth.state excludes "starting" (pre-`started` workers
    // don't appear in health.workers[]). The ONLY ownership signal
    // for a starting row is `locallySpawnedIds`. In registry-only
    // mode the set is empty, so all starting rows are foreign.
    if (!locallySpawnedIds.has(row.workerId)) return "foreign";
    if (now - row.startedAt < PENDING_GRACE_MS) return "pending";
    // Locally-spawned but lingering past grace = backend never produced `started`.
    return "timeout";
  }

  // row.status === "running"
  if (workerSnap === undefined) return "foreign";

  // Heartbeat opt-out: undefined timestamps are the existing L0 contract.
  const last = workerSnap.lastHeartbeatAt ?? null;
  const deadline = workerSnap.heartbeatDeadlineAt ?? null;

  if (deadline === null) return "unmonitored";
  if (last === null) {
    if (now - row.startedAt < PENDING_GRACE_MS) return "pending";
    return "timeout";
  }

  if (now <= deadline) return "ok";
  const interval = deadline - last;
  if (now - deadline < interval) return "stale";
  return "timeout";
}
