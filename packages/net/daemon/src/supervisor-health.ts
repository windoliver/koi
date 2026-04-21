import type {
  AgentId,
  SupervisorHealth,
  SupervisorHealthMetrics,
  SupervisorHealthStatus,
  WorkerHealth,
  WorkerId,
} from "@koi/core";
import type { HeartbeatMonitor } from "./heartbeat-monitor.js";

export function deriveStatus(m: SupervisorHealthMetrics): {
  readonly status: SupervisorHealthStatus;
  readonly reasons: readonly string[];
} {
  if (m.shuttingDown) return { status: "unhealthy", reasons: ["shutting_down"] };
  const reasons: string[] = [];
  if (m.quarantinedCount > 0) reasons.push("quarantined_workers");
  if (m.eventDropCount > 0) reasons.push("event_buffer_drops");
  if (m.poolSize + m.pendingSpawnCount >= m.maxWorkers) reasons.push("at_capacity");
  return { status: reasons.length > 0 ? "degraded" : "ok", reasons };
}

/**
 * Opaque view of the supervisor's internal state maps that `buildHealth`
 * needs to compose a SupervisorHealth snapshot. Kept as a structural type
 * so create-supervisor.ts can pass its closures directly without a class.
 */
export interface SupervisorHealthInputs {
  readonly pool: ReadonlyMap<
    WorkerId,
    { readonly handle: { readonly agentId: AgentId }; readonly stopping: boolean }
  >;
  readonly quarantined: ReadonlyMap<WorkerId, { readonly agentId: AgentId }>;
  readonly restarting: ReadonlyMap<WorkerId, { readonly agentId: AgentId }>;
  readonly metrics: SupervisorHealthMetrics;
  readonly healthMonitor: HeartbeatMonitor;
}

export function buildHealth(inputs: SupervisorHealthInputs): SupervisorHealth {
  const tracked = inputs.healthMonitor.snapshot();
  const trackedIds = new Set(tracked.map((w) => w.workerId));
  const extras: WorkerHealth[] = [];
  for (const [id, entry] of inputs.pool) {
    if (trackedIds.has(id)) continue;
    extras.push({
      workerId: id,
      agentId: entry.handle.agentId,
      state: entry.stopping ? "stopping" : "running",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    });
  }
  for (const [id, q] of inputs.quarantined) {
    if (trackedIds.has(id) || inputs.pool.has(id)) continue;
    extras.push({
      workerId: id,
      agentId: q.agentId,
      state: "quarantined",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    });
  }
  for (const [id, r] of inputs.restarting) {
    if (trackedIds.has(id) || inputs.pool.has(id)) continue;
    extras.push({
      workerId: id,
      agentId: r.agentId,
      state: "restarting",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    });
  }
  const { status, reasons } = deriveStatus(inputs.metrics);
  return { status, reasons, metrics: inputs.metrics, workers: [...tracked, ...extras] };
}
