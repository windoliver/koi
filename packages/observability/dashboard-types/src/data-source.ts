/**
 * DashboardDataSource — adapter interface for dashboard data access.
 *
 * All methods return `T | Promise<T>` so implementations can be sync
 * (in-memory mock) or async (network-backed) without interface changes.
 * Callers must always `await` the result.
 */

import type { AgentId, KoiError, ProcessState, Result } from "@koi/core";
import type { DashboardEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Summary types for list views
// ---------------------------------------------------------------------------

export interface DashboardAgentSummary {
  readonly agentId: AgentId;
  readonly name: string;
  readonly agentType: "copilot" | "worker";
  readonly state: ProcessState;
  readonly model?: string;
  readonly channels: readonly string[];
  readonly turns: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
}

export interface DashboardAgentDetail extends DashboardAgentSummary {
  readonly parentId?: AgentId;
  readonly skills: readonly string[];
  readonly tokenCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DashboardChannelSummary {
  readonly channelId: string;
  readonly channelType: string;
  readonly agentId: AgentId;
  readonly connected: boolean;
  readonly messageCount: number;
  readonly connectedAt: number;
}

export interface DashboardSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly agentId: AgentId;
}

export interface DashboardSystemMetrics {
  readonly uptimeMs: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly activeChannels: number;
}

// ---------------------------------------------------------------------------
// Schema types (for schema probing / detail view)
// ---------------------------------------------------------------------------

export interface DashboardSchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface DashboardSchemaTable {
  readonly name: string;
  readonly schema: string;
  readonly columns: readonly DashboardSchemaColumn[];
  readonly foreignKeys?:
    | readonly {
        readonly column: string;
        readonly referencedTable: string;
        readonly referencedColumn: string;
      }[]
    | undefined;
}

// ---------------------------------------------------------------------------
// Verification + fitness types
// ---------------------------------------------------------------------------

export interface DashboardVerificationStage {
  readonly stage: string;
  readonly passed: boolean;
  readonly durationMs: number;
}

export interface DataSourceFitnessSummary {
  readonly successCount: number;
  readonly errorCount: number;
  readonly successRate: number;
  readonly p95LatencyMs: number | undefined;
  readonly lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// Data source summary (for data source discovery UX)
// ---------------------------------------------------------------------------

export interface DataSourceSummary {
  readonly name: string;
  readonly protocol: string;
  readonly status: "approved" | "pending" | "rejected";
  readonly source: "manifest" | "env" | "mcp";
  readonly fitness?: DataSourceFitnessSummary | undefined;
  readonly verificationProgress?: number | undefined;
}

// ---------------------------------------------------------------------------
// Data source detail (rich schema + provenance view)
// ---------------------------------------------------------------------------

export interface DataSourceDetail {
  readonly name: string;
  readonly protocol: string;
  readonly status: "approved" | "pending" | "rejected";
  readonly source: "manifest" | "env" | "mcp";
  readonly description?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly tables?: readonly DashboardSchemaTable[] | undefined;
  readonly fitness?: DataSourceFitnessSummary | undefined;
  readonly trailStrength?: number | undefined;
  readonly verification?: readonly DashboardVerificationStage[] | undefined;
  readonly provenance?:
    | {
        readonly builder: string;
        readonly forgedAt: number;
        readonly verificationPassed: boolean;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Data source interface
// ---------------------------------------------------------------------------

export interface DashboardDataSource {
  readonly listAgents: () =>
    | readonly DashboardAgentSummary[]
    | Promise<readonly DashboardAgentSummary[]>;

  readonly getAgent: (
    agentId: AgentId,
  ) => DashboardAgentDetail | undefined | Promise<DashboardAgentDetail | undefined>;

  readonly terminateAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly listChannels: () =>
    | readonly DashboardChannelSummary[]
    | Promise<readonly DashboardChannelSummary[]>;

  readonly listSkills: () =>
    | readonly DashboardSkillSummary[]
    | Promise<readonly DashboardSkillSummary[]>;

  readonly getSystemMetrics: () => DashboardSystemMetrics | Promise<DashboardSystemMetrics>;

  readonly subscribe: (listener: (event: DashboardEvent) => void) => () => void;

  // Data source discovery (optional — available when discovery is enabled)
  readonly listDataSources?: () =>
    | readonly DataSourceSummary[]
    | Promise<readonly DataSourceSummary[]>;

  readonly approveDataSource?: (
    name: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly getDataSourceSchema?: (
    name: string,
  ) => DataSourceDetail | undefined | Promise<DataSourceDetail | undefined>;

  /** Trigger a server-side re-scan for new data sources (env, MCP). */
  readonly rescanDataSources?: () =>
    | readonly DataSourceSummary[]
    | Promise<readonly DataSourceSummary[]>;
}
