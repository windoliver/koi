import type { WorkerSpawnRequest } from "@koi/core";

/**
 * True if the spawn request opts into heartbeat monitoring via
 * `backendHints.heartbeat === true`. Shared between `create-supervisor.ts`
 * (for tracking in the health monitor) and `subprocess-backend.ts` (for
 * wiring the Bun IPC handler at spawn time).
 */
export function isHeartbeatOptIn(request: WorkerSpawnRequest): boolean {
  const hints = request.backendHints;
  if (hints === undefined) return false;
  return hints.heartbeat === true;
}
