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
  | DataSourceDashboardEvent;

/** Batched envelope sent over SSE. Monotonic seq for gap detection. */
export interface DashboardEventBatch {
  readonly events: readonly DashboardEvent[];
  readonly seq: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set([
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
]);

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

/** Type guard for agent domain events. */
export function isAgentEvent(event: DashboardEvent): event is AgentDashboardEvent {
  return event.kind === "agent";
}

/** Type guard for skill domain events. */
export function isSkillEvent(event: DashboardEvent): event is SkillDashboardEvent {
  return event.kind === "skill";
}

/** Type guard for channel domain events. */
export function isChannelEvent(event: DashboardEvent): event is ChannelDashboardEvent {
  return event.kind === "channel";
}

/** Type guard for system domain events. */
export function isSystemEvent(event: DashboardEvent): event is SystemDashboardEvent {
  return event.kind === "system";
}

/** Type guard for nexus domain events. */
export function isNexusEvent(event: DashboardEvent): event is NexusDashboardEvent {
  return event.kind === "nexus";
}

/** Type guard for gateway domain events. */
export function isGatewayEvent(event: DashboardEvent): event is GatewayDashboardEvent {
  return event.kind === "gateway";
}

/** Type guard for temporal domain events. */
export function isTemporalEvent(event: DashboardEvent): event is TemporalDashboardEvent {
  return event.kind === "temporal";
}

/** Type guard for scheduler domain events. */
export function isSchedulerEvent(event: DashboardEvent): event is SchedulerDashboardEvent {
  return event.kind === "scheduler";
}

/** Type guard for task board domain events. */
export function isTaskBoardEvent(event: DashboardEvent): event is TaskBoardDashboardEvent {
  return event.kind === "taskboard";
}

/** Type guard for harness domain events. */
export function isHarnessEvent(event: DashboardEvent): event is HarnessDashboardEvent {
  return event.kind === "harness";
}

/** Type guard for data source domain events. */
export function isDataSourceEvent(event: DashboardEvent): event is DataSourceDashboardEvent {
  return event.kind === "datasource";
}
