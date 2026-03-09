/**
 * RuntimeViewDataSource — computed state views for the admin panel.
 *
 * These are read-only projections of engine/gateway state that are
 * NOT file-backed. Surfaced via GET /api/view/* endpoints.
 *
 * All methods return `T | Promise<T>` so implementations can be
 * sync (in-memory engine registry) or async (remote query).
 */

import type { AgentId, ProcessState } from "@koi/core";

// ---------------------------------------------------------------------------
// Process tree — recursive agent hierarchy
// ---------------------------------------------------------------------------

export interface ProcessTreeNode {
  readonly agentId: AgentId;
  readonly name: string;
  readonly state: ProcessState;
  readonly agentType: "copilot" | "worker";
  readonly depth: number;
  readonly children: readonly ProcessTreeNode[];
}

export interface ProcessTreeSnapshot {
  readonly roots: readonly ProcessTreeNode[];
  readonly totalAgents: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Agent procfs — runtime state snapshot (like /proc/PID/status)
// ---------------------------------------------------------------------------

export interface AgentProcfs {
  readonly agentId: AgentId;
  readonly name: string;
  readonly state: ProcessState;
  readonly agentType: "copilot" | "worker";
  readonly model?: string;
  readonly channels: readonly string[];
  readonly turns: number;
  readonly tokenCount: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly parentId?: AgentId;
  readonly childCount: number;
}

// ---------------------------------------------------------------------------
// Middleware chain — ordered middleware for an agent
// ---------------------------------------------------------------------------

export interface MiddlewareEntry {
  readonly name: string;
  readonly phase: "intercept" | "observe" | "resolve";
  readonly enabled: boolean;
}

export interface MiddlewareChain {
  readonly agentId: AgentId;
  readonly entries: readonly MiddlewareEntry[];
}

// ---------------------------------------------------------------------------
// Gateway topology — connected channels and nodes
// ---------------------------------------------------------------------------

export interface GatewayConnection {
  readonly channelId: string;
  readonly channelType: string;
  readonly agentId: AgentId;
  readonly connected: boolean;
  readonly connectedAt: number;
}

export interface GatewayTopology {
  readonly connections: readonly GatewayConnection[];
  readonly nodeCount: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// System metrics (re-exported from data-source for convenience)
// ---------------------------------------------------------------------------

export type { DashboardSystemMetrics } from "./data-source.js";

// ---------------------------------------------------------------------------
// Data source interface
// ---------------------------------------------------------------------------

export interface RuntimeViewDataSource {
  readonly getProcessTree: () => ProcessTreeSnapshot | Promise<ProcessTreeSnapshot>;

  readonly getAgentProcfs: (
    agentId: AgentId,
  ) => AgentProcfs | undefined | Promise<AgentProcfs | undefined>;

  readonly getMiddlewareChain: (agentId: AgentId) => MiddlewareChain | Promise<MiddlewareChain>;

  readonly getGatewayTopology: () => GatewayTopology | Promise<GatewayTopology>;
}
