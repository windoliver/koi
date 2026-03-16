/**
 * Domain sub-reducers — pure functions for each domain view state slice.
 *
 * Each reducer takes the current domain state and an event, returns new state.
 * Handles buffer capping and scroll clamping.
 */

import type {
  ChannelDashboardEvent,
  GatewayDashboardEvent,
  HarnessDashboardEvent,
  NexusDashboardEvent,
  SchedulerDashboardEvent,
  SkillDashboardEvent,
  SystemDashboardEvent,
  TaskBoardDashboardEvent,
  TemporalDashboardEvent,
} from "@koi/dashboard-types";
import type {
  ChannelsViewState,
  GatewayViewState,
  GovernanceViewState,
  HarnessViewState,
  NexusViewState,
  SchedulerViewState,
  SkillsViewState,
  SystemViewState,
  TaskBoardViewState,
  TemporalViewState,
} from "./domain-types.js";
import {
  MAX_CHANNEL_EVENTS,
  MAX_GATEWAY_EVENTS,
  MAX_GOVERNANCE_VIOLATIONS,
  MAX_HARNESS_EVENTS,
  MAX_NEXUS_EVENTS,
  MAX_SCHEDULER_EVENTS,
  MAX_SKILL_EVENTS,
  MAX_SYSTEM_EVENTS,
  MAX_TASKBOARD_EVENTS,
  MAX_TEMPORAL_EVENTS,
} from "./domain-types.js";

/** Append to a capped buffer. */
function appendCapped<T>(buffer: readonly T[], item: T, max: number): readonly T[] {
  const combined = [...buffer, item];
  return combined.length > max ? combined.slice(-max) : combined;
}

export function reduceSkills(state: SkillsViewState, event: SkillDashboardEvent): SkillsViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_SKILL_EVENTS),
  };
}

export function reduceChannels(
  state: ChannelsViewState,
  event: ChannelDashboardEvent,
): ChannelsViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_CHANNEL_EVENTS),
  };
}

export function reduceSystem(state: SystemViewState, event: SystemDashboardEvent): SystemViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_SYSTEM_EVENTS),
  };
}

export function reduceNexus(state: NexusViewState, event: NexusDashboardEvent): NexusViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_NEXUS_EVENTS),
  };
}

export function reduceGateway(
  state: GatewayViewState,
  event: GatewayDashboardEvent,
): GatewayViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_GATEWAY_EVENTS),
  };
}

export function reduceTemporal(
  state: TemporalViewState,
  event: TemporalDashboardEvent,
): TemporalViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_TEMPORAL_EVENTS),
  };
}

export function reduceScheduler(
  state: SchedulerViewState,
  event: SchedulerDashboardEvent,
): SchedulerViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_SCHEDULER_EVENTS),
  };
}

export function reduceTaskBoard(
  state: TaskBoardViewState,
  event: TaskBoardDashboardEvent,
): TaskBoardViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_TASKBOARD_EVENTS),
    // Invalidate layout cache on status change
    cachedLayout: null,
  };
}

export function reduceHarness(
  state: HarnessViewState,
  event: HarnessDashboardEvent,
): HarnessViewState {
  return {
    ...state,
    events: appendCapped(state.events, event, MAX_HARNESS_EVENTS),
  };
}

/** Compute ASCII DAG layout from nodes and edges. */
export function computeDagLayout(
  nodes: readonly import("@koi/dashboard-types").TaskBoardNode[],
  edges: readonly import("@koi/dashboard-types").TaskBoardEdge[],
): readonly string[] {
  if (nodes.length === 0) return ["(empty)"];

  // Build adjacency for topological sort
  const incoming = new Map<string, readonly string[]>();
  const outgoing = new Map<string, readonly string[]>();
  for (const node of nodes) {
    incoming.set(node.taskId, []);
    outgoing.set(node.taskId, []);
  }
  for (const edge of edges) {
    const prev = outgoing.get(edge.from) ?? [];
    outgoing.set(edge.from, [...prev, edge.to]);
    const prevIn = incoming.get(edge.to) ?? [];
    incoming.set(edge.to, [...prevIn, edge.from]);
  }

  // Kahn's topological sort for layer assignment
  const layers: string[][] = [];
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.taskId, (incoming.get(node.taskId) ?? []).length);
  }
  let queue = nodes.filter((n) => (inDegree.get(n.taskId) ?? 0) === 0).map((n) => n.taskId);
  while (queue.length > 0) {
    layers.push([...queue]);
    const nextQueue: string[] = [];
    for (const id of queue) {
      for (const child of outgoing.get(id) ?? []) {
        const deg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, deg);
        if (deg === 0) nextQueue.push(child);
      }
    }
    queue = nextQueue;
  }

  // Render layers
  const nodeMap = new Map(nodes.map((n) => [n.taskId, n]));
  const STATUS_ICONS: Readonly<Record<string, string>> = {
    pending: "○",
    running: "◉",
    completed: "●",
    failed: "✗",
  } as const;

  const lines: string[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer === undefined) continue;
    const row = layer
      .map((id) => {
        const node = nodeMap.get(id);
        if (node === undefined) return id;
        const icon = STATUS_ICONS[node.status] ?? "?";
        return `${icon} ${node.label}`;
      })
      .join("  │  ");
    lines.push(row);
    if (i < layers.length - 1) {
      lines.push("  │");
    }
  }
  return lines;
}

/** Clamp scroll offset to valid range. */
export function clampScroll(offset: number, itemCount: number, visibleRows: number): number {
  const maxOffset = Math.max(0, itemCount - visibleRows);
  return Math.max(0, Math.min(offset, maxOffset));
}

/** Reduce governance approval addition. */
export function addGovernanceApproval(
  state: GovernanceViewState,
  approval: GovernanceViewState["pendingApprovals"][number],
): GovernanceViewState {
  return {
    ...state,
    pendingApprovals: [...state.pendingApprovals, approval],
  };
}

/** Reduce governance approval removal. */
export function removeGovernanceApproval(
  state: GovernanceViewState,
  id: string,
): GovernanceViewState {
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id),
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, state.pendingApprovals.length - 2)),
  };
}

/** Add a governance violation, capping at MAX_GOVERNANCE_VIOLATIONS. */
export function addGovernanceViolation(
  state: GovernanceViewState,
  violation: GovernanceViewState["violations"][number],
): GovernanceViewState {
  const combined = [...state.violations, violation];
  return {
    ...state,
    violations:
      combined.length > MAX_GOVERNANCE_VIOLATIONS
        ? combined.slice(-MAX_GOVERNANCE_VIOLATIONS)
        : combined,
  };
}
