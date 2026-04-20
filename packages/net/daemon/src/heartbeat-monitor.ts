import type { AgentId, HeartbeatConfig, WorkerEvent, WorkerHealth, WorkerId } from "@koi/core";

export interface HeartbeatMonitorDeps {
  readonly publishEvent: (ev: WorkerEvent) => void;
  readonly teardown: (id: WorkerId, reason: string) => Promise<void>;
  readonly now: () => number;
}

export interface HeartbeatMonitor {
  readonly track: (id: WorkerId, agentId: AgentId, config: HeartbeatConfig) => void;
  readonly observe: (id: WorkerId) => void;
  readonly untrack: (id: WorkerId) => void;
  readonly shutdown: () => void;
  readonly snapshot: () => readonly WorkerHealth[];
}

interface MonitorEntry {
  readonly agentId: AgentId;
  readonly config: HeartbeatConfig;
  lastHeartbeatAt: number;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createHeartbeatMonitor(deps: HeartbeatMonitorDeps): HeartbeatMonitor {
  const entries = new Map<WorkerId, MonitorEntry>();
  let isShutdown = false;

  const armTimer = (id: WorkerId, entry: MonitorEntry): void => {
    entry.timer = setTimeout(() => onDeadline(id), entry.config.timeoutMs);
  };

  const onDeadline = (id: WorkerId): void => {
    if (isShutdown) return;
    const entry = entries.get(id);
    if (entry === undefined) return;
    // retryable=false: timeout implies caller tore the worker down; auto-restart policy is deferred to a future issue.
    deps.publishEvent({
      kind: "crashed",
      workerId: id,
      at: deps.now(),
      error: {
        code: "HEARTBEAT_TIMEOUT",
        message: `No heartbeat from worker ${id} within ${entry.config.timeoutMs}ms`,
        retryable: false,
      },
    });
    deps.teardown(id, "heartbeat-timeout").catch(() => undefined);
  };

  const track: HeartbeatMonitor["track"] = (id, agentId, config) => {
    if (isShutdown) return;
    const existing = entries.get(id);
    if (existing?.timer !== undefined) clearTimeout(existing.timer);
    const now = deps.now();
    const entry: MonitorEntry = {
      agentId,
      config,
      lastHeartbeatAt: now,
      deadlineAt: now + config.timeoutMs,
      timer: undefined,
    };
    entries.set(id, entry);
    armTimer(id, entry);
  };

  const observe: HeartbeatMonitor["observe"] = (id) => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const now = deps.now();
    entry.lastHeartbeatAt = now;
    entry.deadlineAt = now + entry.config.timeoutMs;
    armTimer(id, entry);
  };

  const untrack: HeartbeatMonitor["untrack"] = (id) => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entries.delete(id);
  };

  const shutdown: HeartbeatMonitor["shutdown"] = () => {
    isShutdown = true;
    for (const entry of entries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    entries.clear();
  };

  const snapshot: HeartbeatMonitor["snapshot"] = () => {
    const out: WorkerHealth[] = [];
    for (const [id, entry] of entries) {
      out.push({
        workerId: id,
        agentId: entry.agentId,
        state: "running",
        lastHeartbeatAt: entry.lastHeartbeatAt,
        heartbeatDeadlineAt: entry.deadlineAt,
      });
    }
    return out;
  };

  return { track, observe, untrack, shutdown, snapshot };
}
