/**
 * Dashboard event types — namespaced discriminated unions for SSE streaming.
 *
 * Events are organized by domain (agent, skill, channel, system) with
 * a top-level `kind` discriminator and a `subKind` sub-discriminator.
 * Batched into DashboardEventBatch envelopes for efficient SSE transport.
 */

import type { AgentId, ProcessState } from "@koi/core";

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

export type AgentDashboardEvent =
  | {
      readonly kind: "agent";
      readonly subKind: "status_changed";
      readonly agentId: AgentId;
      readonly from: ProcessState;
      readonly to: ProcessState;
      readonly timestamp: number;
    }
  | {
      readonly kind: "agent";
      readonly subKind: "dispatched";
      readonly agentId: AgentId;
      readonly name: string;
      readonly agentType: "copilot" | "worker";
      readonly timestamp: number;
    }
  | {
      readonly kind: "agent";
      readonly subKind: "terminated";
      readonly agentId: AgentId;
      readonly reason?: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "agent";
      readonly subKind: "metrics_updated";
      readonly agentId: AgentId;
      readonly turns: number;
      readonly tokenCount: number;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Skill events
// ---------------------------------------------------------------------------

export type SkillDashboardEvent =
  | {
      readonly kind: "skill";
      readonly subKind: "installed";
      readonly name: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "skill";
      readonly subKind: "removed";
      readonly name: string;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Channel events
// ---------------------------------------------------------------------------

export type ChannelDashboardEvent =
  | {
      readonly kind: "channel";
      readonly subKind: "connected";
      readonly channelId: string;
      readonly channelType: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "channel";
      readonly subKind: "disconnected";
      readonly channelId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "channel";
      readonly subKind: "message_received";
      readonly channelId: string;
      readonly agentId: AgentId;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// System events
// ---------------------------------------------------------------------------

export type SystemDashboardEvent =
  | {
      readonly kind: "system";
      readonly subKind: "memory_warning";
      readonly heapUsedMb: number;
      readonly heapLimitMb: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "system";
      readonly subKind: "error";
      readonly message: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "system";
      readonly subKind: "activity";
      readonly message: string;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Nexus events (file tree changes)
// ---------------------------------------------------------------------------

export type NexusDashboardEvent =
  | {
      readonly kind: "nexus";
      readonly subKind: "file_changed";
      readonly path: string;
      readonly changeType: "created" | "updated" | "deleted";
      readonly timestamp: number;
    }
  | {
      readonly kind: "nexus";
      readonly subKind: "namespace_changed";
      readonly agentId: AgentId;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Gateway events (connection changes)
// ---------------------------------------------------------------------------

export type GatewayDashboardEvent =
  | {
      readonly kind: "gateway";
      readonly subKind: "connection_changed";
      readonly channelId: string;
      readonly channelType: string;
      readonly connected: boolean;
      readonly timestamp: number;
    }
  | {
      readonly kind: "gateway";
      readonly subKind: "topology_changed";
      readonly nodeCount: number;
      readonly connectionCount: number;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Temporal events (workflow lifecycle)
// ---------------------------------------------------------------------------

export type TemporalDashboardEvent =
  | {
      readonly kind: "temporal";
      readonly subKind: "workflow_started";
      readonly workflowId: string;
      readonly workflowType: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "temporal";
      readonly subKind: "workflow_completed";
      readonly workflowId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "temporal";
      readonly subKind: "health_changed";
      readonly healthy: boolean;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Scheduler events (task lifecycle + cron)
// ---------------------------------------------------------------------------

export type SchedulerDashboardEvent =
  | {
      readonly kind: "scheduler";
      readonly subKind: "task_submitted";
      readonly taskId: string;
      readonly agentId: AgentId;
      readonly timestamp: number;
    }
  | {
      readonly kind: "scheduler";
      readonly subKind: "task_completed";
      readonly taskId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "scheduler";
      readonly subKind: "task_dead_letter";
      readonly taskId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "scheduler";
      readonly subKind: "schedule_fired";
      readonly scheduleId: string;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Task board events (DAG task status)
// ---------------------------------------------------------------------------

export type TaskBoardDashboardEvent = {
  readonly kind: "taskboard";
  readonly subKind: "task_status_changed";
  readonly taskId: string;
  readonly status: string;
  readonly timestamp: number;
};

// ---------------------------------------------------------------------------
// Harness events (long-running agent orchestration)
// ---------------------------------------------------------------------------

export type HarnessDashboardEvent =
  | {
      readonly kind: "harness";
      readonly subKind: "checkpoint_created";
      readonly checkpointType: "soft" | "hard";
      readonly timestamp: number;
    }
  | {
      readonly kind: "harness";
      readonly subKind: "phase_changed";
      readonly from: string;
      readonly to: string;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Data source events (discovery + connector lifecycle)
// ---------------------------------------------------------------------------

export type DataSourceDashboardEvent =
  | {
      readonly kind: "datasource";
      readonly subKind: "data_source_discovered";
      readonly name: string;
      readonly protocol: string;
      readonly source: "manifest" | "env" | "mcp";
      readonly timestamp: number;
    }
  | {
      readonly kind: "datasource";
      readonly subKind: "connector_forged";
      readonly name: string;
      readonly protocol: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "datasource";
      readonly subKind: "connector_health_update";
      readonly name: string;
      readonly healthy: boolean;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Forge events (self-improvement observability)
// ---------------------------------------------------------------------------

export type ForgeDashboardEvent =
  | {
      readonly kind: "forge";
      readonly subKind: "brick_forged";
      readonly brickId: string;
      readonly name: string;
      readonly origin: "crystallize";
      readonly ngramKey: string;
      readonly occurrences: number;
      readonly score: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "brick_demand_forged";
      readonly brickId: string;
      readonly name: string;
      readonly triggerId: string;
      readonly triggerKind: string;
      readonly confidence: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "brick_deprecated";
      readonly brickId: string;
      readonly reason: string;
      readonly fitnessOriginal: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "brick_promoted";
      readonly brickId: string;
      readonly fitnessOriginal: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "brick_quarantined";
      readonly brickId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "demand_detected";
      readonly signalId: string;
      readonly triggerKind: string;
      readonly confidence: number;
      readonly suggestedBrickKind: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "crystallize_candidate";
      readonly ngramKey: string;
      readonly occurrences: number;
      readonly suggestedName: string;
      readonly score: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "forge";
      readonly subKind: "fitness_flushed";
      readonly brickId: string;
      readonly successRate: number;
      readonly sampleCount: number;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Monitor events (agent anomaly detection)
// ---------------------------------------------------------------------------

export type MonitorDashboardEvent = {
  readonly kind: "monitor";
  readonly subKind: "anomaly_detected";
  readonly anomalyKind: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
};

// ---------------------------------------------------------------------------
// PTY output events (raw terminal bytes from agent subprocesses)
// ---------------------------------------------------------------------------

/** PTY output event — raw terminal bytes from an agent subprocess. */
export interface PtyOutputDashboardEvent {
  readonly kind: "pty_output";
  readonly subKind: "pty_data";
  readonly agentId: string;
  /** Base64-encoded PTY bytes (batched at ~50-100ms intervals by dashboard-api). */
  readonly data: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Union + batch envelope
// ---------------------------------------------------------------------------

export type DashboardEvent =
  | AgentDashboardEvent
  | SkillDashboardEvent
  | ChannelDashboardEvent
  | SystemDashboardEvent
  | NexusDashboardEvent
  | GatewayDashboardEvent
  | TemporalDashboardEvent
  | SchedulerDashboardEvent
  | TaskBoardDashboardEvent
  | HarnessDashboardEvent
  | DataSourceDashboardEvent
  | ForgeDashboardEvent
  | MonitorDashboardEvent
  | PtyOutputDashboardEvent;

/** Batched envelope sent over SSE. Monotonic seq for gap detection. */
export interface DashboardEventBatch {
  readonly events: readonly DashboardEvent[];
  readonly seq: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const VALID_KINDS_ARRAY = [
  "agent",
  "skill",
  "channel",
  "system",
  "nexus",
  "gateway",
  "temporal",
  "scheduler",
  "taskboard",
  "harness",
  "datasource",
  "forge",
  "monitor",
  "pty_output",
] as const;

const VALID_KINDS = new Set<string>(VALID_KINDS_ARRAY);

/** Type guard for DashboardEvent. Validates kind + subKind presence. */
export function isDashboardEvent(value: unknown): value is DashboardEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.kind === "string" &&
    VALID_KINDS.has(v.kind) &&
    typeof v.subKind === "string" &&
    typeof v.timestamp === "number"
  );
}

/** Factory for domain-scoped type guards. */
function createKindGuard<K extends DashboardEvent["kind"]>(
  kind: K,
): (event: DashboardEvent) => event is Extract<DashboardEvent, { readonly kind: K }> {
  return (event: DashboardEvent): event is Extract<DashboardEvent, { readonly kind: K }> =>
    event.kind === kind;
}

export const isAgentEvent: (event: DashboardEvent) => event is AgentDashboardEvent =
  createKindGuard("agent");
export const isSkillEvent: (event: DashboardEvent) => event is SkillDashboardEvent =
  createKindGuard("skill");
export const isChannelEvent: (event: DashboardEvent) => event is ChannelDashboardEvent =
  createKindGuard("channel");
export const isSystemEvent: (event: DashboardEvent) => event is SystemDashboardEvent =
  createKindGuard("system");
export const isNexusEvent: (event: DashboardEvent) => event is NexusDashboardEvent =
  createKindGuard("nexus");
export const isGatewayEvent: (event: DashboardEvent) => event is GatewayDashboardEvent =
  createKindGuard("gateway");
export const isTemporalEvent: (event: DashboardEvent) => event is TemporalDashboardEvent =
  createKindGuard("temporal");
export const isSchedulerEvent: (event: DashboardEvent) => event is SchedulerDashboardEvent =
  createKindGuard("scheduler");
export const isTaskBoardEvent: (event: DashboardEvent) => event is TaskBoardDashboardEvent =
  createKindGuard("taskboard");
export const isHarnessEvent: (event: DashboardEvent) => event is HarnessDashboardEvent =
  createKindGuard("harness");
export const isDataSourceEvent: (event: DashboardEvent) => event is DataSourceDashboardEvent =
  createKindGuard("datasource");
export const isForgeEvent: (event: DashboardEvent) => event is ForgeDashboardEvent =
  createKindGuard("forge");
export const isMonitorEvent: (event: DashboardEvent) => event is MonitorDashboardEvent =
  createKindGuard("monitor");
export const isPtyOutputEvent: (event: DashboardEvent) => event is PtyOutputDashboardEvent =
  createKindGuard("pty_output");
