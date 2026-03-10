/**
 * createAdminPanelBridge — adapts live CLI runtime state into
 * DashboardHandlerOptions for the admin panel HTTP handler.
 *
 * The bridge accepts a minimal set of inputs from the CLI runtime and
 * exposes them through the DashboardDataSource interface. It tracks
 * a single primary agent with its channels and skills, providing
 * system metrics from the Bun runtime.
 *
 * This is designed for CLI-hosted agents where there is exactly one
 * agent running. For multi-agent deployments, use the engine registry
 * directly with a full data source implementation.
 */

import type { AgentId, KoiError, ProcessState, Result } from "@koi/core";
import { agentId } from "@koi/core";
import type {
  AgentProcfs,
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardDataSource,
  DashboardEvent,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  GatewayTopology,
  MiddlewareChain,
  ProcessTreeSnapshot,
  RuntimeViewDataSource,
} from "@koi/dashboard-types";
import type { DashboardHandlerOptions } from "./handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** Display name of the agent (from manifest). */
  readonly agentName: string;
  /** Agent type: copilot or worker. */
  readonly agentType: "copilot" | "worker";
  /** Model name (e.g. "anthropic:claude-sonnet-4-5-20250929"). */
  readonly model?: string | undefined;
  /** Channel type names (e.g. ["cli", "telegram"]). */
  readonly channels: readonly string[];
  /** Skill names (e.g. ["web-search", "code-review"]). */
  readonly skills: readonly string[];
}

export interface AdminPanelBridgeResult extends DashboardHandlerOptions {
  /** Emit a dashboard event to all subscribers. */
  readonly emitEvent: (event: DashboardEvent) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdminPanelBridge(options: BridgeOptions): AdminPanelBridgeResult {
  const primaryAgentId = agentId(`cli:${options.agentName}:${Date.now()}`);
  const startedAt = Date.now();
  const listeners = new Set<(event: DashboardEvent) => void>();

  // Mutable agent state — tracks lifecycle transitions
  // let justified: state changes on terminate, read by list/get/terminate
  let agentState: ProcessState = "running";

  const emitEvent = (event: DashboardEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const buildSummary = (): DashboardAgentSummary => ({
    agentId: primaryAgentId,
    name: options.agentName,
    agentType: options.agentType,
    state: agentState,
    ...(options.model !== undefined ? { model: options.model } : {}),
    channels: [...options.channels],
    turns: 0,
    startedAt,
    lastActivityAt: Date.now(),
  });

  const buildDetail = (): DashboardAgentDetail => ({
    ...buildSummary(),
    skills: [...options.skills],
    tokenCount: 0,
    metadata: {},
  });

  const dataSource: DashboardDataSource = {
    listAgents(): readonly DashboardAgentSummary[] {
      return [buildSummary()];
    },

    getAgent(id: AgentId): DashboardAgentDetail | undefined {
      if (id !== primaryAgentId) return undefined;
      return buildDetail();
    },

    terminateAgent(id: AgentId): Result<void, KoiError> {
      if (id !== primaryAgentId) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Agent ${id} not found`,
            retryable: false,
          },
        };
      }

      if (agentState === "terminated") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Agent ${id} is already terminated`,
            retryable: false,
          },
        };
      }

      const previousState = agentState;
      agentState = "terminated";

      emitEvent({
        kind: "agent",
        subKind: "status_changed",
        agentId: primaryAgentId,
        from: previousState,
        to: "terminated",
        timestamp: Date.now(),
      });

      return { ok: true, value: undefined };
    },

    listChannels(): readonly DashboardChannelSummary[] {
      return options.channels.map((channelType, index) => ({
        channelId: `${channelType}:${String(index)}`,
        channelType,
        agentId: primaryAgentId,
        connected: true,
        messageCount: 0,
        connectedAt: startedAt,
      }));
    },

    listSkills(): readonly DashboardSkillSummary[] {
      return options.skills.map((name) => ({
        name,
        description: "",
        tags: [],
        agentId: primaryAgentId,
      }));
    },

    getSystemMetrics(): DashboardSystemMetrics {
      const heapUsed = process.memoryUsage().heapUsed;
      const heapTotal = process.memoryUsage().heapTotal;

      return {
        uptimeMs: Date.now() - startedAt,
        heapUsedMb: Math.round((heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMb: Math.round((heapTotal / 1024 / 1024) * 100) / 100,
        activeAgents: 1,
        totalAgents: 1,
        activeChannels: options.channels.length,
      };
    },

    subscribe(listener: (event: DashboardEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const runtimeViews: RuntimeViewDataSource = {
    getProcessTree(): ProcessTreeSnapshot {
      return {
        roots: [
          {
            agentId: primaryAgentId,
            name: options.agentName,
            state: agentState,
            agentType: options.agentType,
            depth: 0,
            children: [],
          },
        ],
        totalAgents: 1,
        timestamp: Date.now(),
      };
    },

    getAgentProcfs(id: AgentId): AgentProcfs | undefined {
      if (id !== primaryAgentId) return undefined;

      return {
        agentId: primaryAgentId,
        name: options.agentName,
        state: agentState,
        agentType: options.agentType,
        ...(options.model !== undefined ? { model: options.model } : {}),
        channels: [...options.channels],
        turns: 0,
        tokenCount: 0,
        startedAt,
        lastActivityAt: Date.now(),
        childCount: 0,
      };
    },

    getMiddlewareChain(id: AgentId): MiddlewareChain {
      return {
        agentId: id,
        entries: [],
      };
    },

    getGatewayTopology(): GatewayTopology {
      return {
        connections: options.channels.map((channelType, index) => ({
          channelId: `${channelType}:${String(index)}`,
          channelType,
          agentId: primaryAgentId,
          connected: true,
          connectedAt: startedAt,
        })),
        nodeCount: options.channels.length,
        timestamp: Date.now(),
      };
    },
  };

  return {
    dataSource,
    runtimeViews,
    emitEvent,
  };
}
