/**
 * Typed HTTP client for the Koi admin API.
 *
 * All methods return Result<T, DashboardClientError> — never throw.
 * Uses ADMIN_ROUTES from @koi/dashboard-types for URL construction.
 */

import type {
  AgentMessage,
  AgentProcfs,
  ApiResult,
  CheckpointEntry,
  CronSchedule,
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  DataSourceSummary,
  DelegationSummary,
  ForgeBrickView,
  ForgeStats,
  GatewayTopology,
  GovernancePendingItem,
  HandoffSummary,
  HarnessStatus,
  MiddlewareChain,
  ProcessTreeSnapshot,
  SchedulerDeadLetterEntry,
  SchedulerStats,
  SchedulerTaskSummary,
  ScratchpadEntryDetail,
  ScratchpadEntrySummary,
  TaskBoardSnapshot,
  TemporalHealth,
  WorkflowDetail,
  WorkflowSummary,
} from "@koi/dashboard-types";
import { ADMIN_ROUTES, interpolatePath } from "@koi/dashboard-types";
import type { DashboardClientError } from "../types.js";

/** Typed result for client operations. */
export type ClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DashboardClientError };

/** Configuration for the admin client. */
export interface AdminClientConfig {
  /** Base URL of the admin API (e.g., "http://localhost:3100/admin/api"). */
  readonly baseUrl: string;
  /** Optional auth token for authenticated requests. */
  readonly authToken?: string;
  /** Request timeout in milliseconds (default: 10000). */
  readonly timeoutMs?: number;
}

/** Dispatch request body for creating a new agent. */
export interface DispatchRequest {
  readonly name: string;
  readonly manifest?: string;
  readonly message?: string;
}

/** Dispatch response with the new agent's ID. */
export interface DispatchResponse {
  readonly agentId: string;
  readonly name: string;
}

/** Filesystem listing entry. */
export interface FsEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size?: number;
  readonly modifiedAt?: number;
}

/** Typed admin API client. */
export interface AdminClient {
  readonly listAgents: () => Promise<ClientResult<readonly DashboardAgentSummary[]>>;
  readonly getAgent: (agentId: string) => Promise<ClientResult<DashboardAgentDetail>>;
  readonly listChannels: () => Promise<ClientResult<readonly DashboardChannelSummary[]>>;
  readonly listSkills: () => Promise<ClientResult<readonly DashboardSkillSummary[]>>;
  readonly getMetrics: () => Promise<ClientResult<DashboardSystemMetrics>>;
  readonly getProcessTree: () => Promise<ClientResult<ProcessTreeSnapshot>>;
  readonly getAgentProcfs: (agentId: string) => Promise<ClientResult<AgentProcfs>>;
  readonly suspendAgent: (agentId: string) => Promise<ClientResult<null>>;
  readonly resumeAgent: (agentId: string) => Promise<ClientResult<null>>;
  readonly terminateAgent: (agentId: string) => Promise<ClientResult<null>>;
  readonly dispatchAgent: (req: DispatchRequest) => Promise<ClientResult<DispatchResponse>>;
  readonly checkHealth: () => Promise<
    ClientResult<{
      readonly status: string;
      readonly capabilities?: {
        readonly temporal: boolean;
        readonly scheduler: boolean;
        readonly taskboard: boolean;
        readonly harness: boolean;
        readonly forge: boolean;
        readonly gateway: boolean;
        readonly nexus: boolean;
        readonly governance: boolean;
      };
    }>
  >;
  readonly fsList: (path: string) => Promise<ClientResult<readonly FsEntry[]>>;
  readonly fsRead: (path: string) => Promise<ClientResult<string>>;
  readonly fsWrite: (path: string, content: string) => Promise<ClientResult<null>>;
  /** List all discovered data sources. */
  readonly listDataSources: () => Promise<ClientResult<readonly DataSourceSummary[]>>;
  /** Approve a pending data source by name. */
  readonly approveDataSource: (name: string) => Promise<ClientResult<null>>;
  /** Reject a pending data source by name. */
  readonly rejectDataSource: (name: string) => Promise<ClientResult<null>>;
  /** Fetch schema for a data source. */
  readonly getDataSourceSchema: (
    name: string,
  ) => Promise<ClientResult<Readonly<Record<string, unknown>>>>;
  /** Trigger a server-side rescan for new data sources. */
  readonly rescanDataSources: () => Promise<ClientResult<readonly DataSourceSummary[]>>;
  // ─── Runtime views ───────────────────────────────────────────────
  /** Fetch middleware chain for an agent. */
  readonly getMiddlewareChain: (agentId: string) => Promise<ClientResult<MiddlewareChain>>;
  /** Fetch gateway topology. */
  readonly getGatewayTopology: () => Promise<ClientResult<GatewayTopology>>;
  /** List forge bricks. */
  readonly listForgeBricks: () => Promise<ClientResult<readonly ForgeBrickView[]>>;
  /** Get forge stats. */
  readonly getForgeStats: () => Promise<ClientResult<ForgeStats>>;
  /** List recent forge events. */
  readonly listForgeEvents: () => Promise<
    ClientResult<readonly import("@koi/dashboard-types").ForgeDashboardEvent[]>
  >;
  // ─── Temporal orchestration ─────────────────────────────────────
  /** Check Temporal server health. */
  readonly getTemporalHealth: () => Promise<ClientResult<TemporalHealth>>;
  /** List active workflows. */
  readonly listWorkflows: () => Promise<ClientResult<readonly WorkflowSummary[]>>;
  /** Get workflow detail by ID. */
  readonly getWorkflow: (workflowId: string) => Promise<ClientResult<WorkflowDetail>>;
  /** Send a signal to a workflow. */
  readonly signalWorkflow: (workflowId: string, signal: string) => Promise<ClientResult<null>>;
  /** Terminate a workflow. */
  readonly terminateWorkflow: (workflowId: string) => Promise<ClientResult<null>>;
  // ─── Scheduler orchestration ────────────────────────────────────
  /** List scheduler tasks. */
  readonly listSchedulerTasks: () => Promise<ClientResult<readonly SchedulerTaskSummary[]>>;
  /** Get scheduler stats. */
  readonly getSchedulerStats: () => Promise<ClientResult<SchedulerStats>>;
  /** List cron schedules. */
  readonly listSchedules: () => Promise<ClientResult<readonly CronSchedule[]>>;
  /** List dead letter entries. */
  readonly listDeadLetters: () => Promise<ClientResult<readonly SchedulerDeadLetterEntry[]>>;
  /** Retry a dead letter entry. */
  readonly retryDeadLetter: (entryId: string) => Promise<ClientResult<null>>;
  /** Pause a schedule. */
  readonly pauseSchedule: (scheduleId: string) => Promise<ClientResult<null>>;
  /** Resume a schedule. */
  readonly resumeSchedule: (scheduleId: string) => Promise<ClientResult<null>>;
  // ─── TaskBoard ──────────────────────────────────────────────────
  /** Get task board DAG snapshot. */
  readonly getTaskBoardSnapshot: () => Promise<ClientResult<TaskBoardSnapshot>>;
  // ─── Harness ────────────────────────────────────────────────────
  /** Get harness status. */
  readonly getHarnessStatus: () => Promise<ClientResult<HarnessStatus>>;
  /** List harness checkpoints. */
  readonly listCheckpoints: () => Promise<ClientResult<readonly CheckpointEntry[]>>;
  /** Pause the harness. */
  readonly pauseHarness: () => Promise<ClientResult<null>>;
  /** Resume the harness. */
  readonly resumeHarness: () => Promise<ClientResult<null>>;
  // ─── Delegation ────────────────────────────────────────────────
  /** List delegation grants for an agent. */
  readonly listDelegations: (
    agentId: string,
  ) => Promise<ClientResult<readonly DelegationSummary[]>>;
  // ─── Handoffs ─────────────────────────────────────────────────
  /** List handoff envelopes for an agent. */
  readonly listHandoffs: (agentId: string) => Promise<ClientResult<readonly HandoffSummary[]>>;
  // ─── Scratchpad ───────────────────────────────────────────────
  /** List scratchpad entries, optionally filtered by group. */
  readonly listScratchpad: (
    groupId?: string,
  ) => Promise<ClientResult<readonly ScratchpadEntrySummary[]>>;
  /** Read a single scratchpad entry by path. */
  readonly readScratchpad: (path: string) => Promise<ClientResult<ScratchpadEntryDetail>>;
  // ─── Mailbox ──────────────────────────────────────────────────
  /** List mailbox messages for an agent. */
  readonly listMailbox: (agentId: string) => Promise<ClientResult<readonly AgentMessage[]>>;
  // ─── Governance ───────────────────────────────────────────────
  /** List the governance pending queue. */
  readonly listGovernanceQueue: () => Promise<ClientResult<readonly GovernancePendingItem[]>>;
  /** Approve or reject a governance item. */
  readonly reviewGovernance: (
    id: string,
    decision: "approved" | "rejected",
    reason?: string,
  ) => Promise<ClientResult<null>>;
  // ─── Forge Brick Lifecycle ────────────────────────────────────
  /** Promote a brick. */
  readonly promoteBrick: (brickId: string) => Promise<ClientResult<null>>;
  /** Demote a brick. */
  readonly demoteBrick: (brickId: string) => Promise<ClientResult<null>>;
  /** Quarantine a brick. */
  readonly quarantineBrick: (brickId: string) => Promise<ClientResult<null>>;
  /** Build the SSE events URL for reconnecting stream. */
  readonly eventsUrl: () => string;
  /** Build the AG-UI chat URL for a specific agent. */
  readonly agentChatUrl: (agentId: string) => string;
}

/**
 * Create a typed admin API client.
 *
 * All methods return Result — never throw for expected failures.
 */
export function createAdminClient(config: AdminClientConfig): AdminClient {
  const { baseUrl, authToken, timeoutMs = 10_000 } = config;

  function url(path: string, params?: Readonly<Record<string, string>>): string {
    const interpolated = params !== undefined ? interpolatePath(path, params) : path;
    return `${baseUrl}${interpolated}`;
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken !== undefined) {
      h.Authorization = `Bearer ${authToken}`;
    }
    return h;
  }

  async function request<T>(
    method: string,
    path: string,
    params?: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<ClientResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url(path, params), {
        method,
        headers: headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: {
            kind: "auth_failed",
            message: `Authentication failed (${String(response.status)})`,
          },
        };
      }

      const json: unknown = await response.json();

      if (!isApiResult(json)) {
        return {
          ok: false,
          error: {
            kind: "api_error",
            code: "INVALID_RESPONSE",
            message: "Response is not a valid ApiResult envelope",
          },
        };
      }

      if (!json.ok) {
        return {
          ok: false,
          error: {
            kind: "api_error",
            code: json.error.code,
            message: json.error.message,
          },
        };
      }

      return { ok: true, value: json.data as T };
    } catch (error: unknown) {
      return mapFetchError(error, url(path, params), timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listAgents: () =>
      request<readonly DashboardAgentSummary[]>("GET", ADMIN_ROUTES.listAgents.path),

    getAgent: (agentId) =>
      request<DashboardAgentDetail>("GET", ADMIN_ROUTES.getAgent.path, { id: agentId }),

    listChannels: () =>
      request<readonly DashboardChannelSummary[]>("GET", ADMIN_ROUTES.listChannels.path),

    listSkills: () =>
      request<readonly DashboardSkillSummary[]>("GET", ADMIN_ROUTES.listSkills.path),

    getMetrics: () => request<DashboardSystemMetrics>("GET", ADMIN_ROUTES.getMetrics.path),

    getProcessTree: () => request<ProcessTreeSnapshot>("GET", ADMIN_ROUTES.processTree.path),

    getAgentProcfs: (agentId) =>
      request<AgentProcfs>("GET", ADMIN_ROUTES.agentProcfs.path, { id: agentId }),

    suspendAgent: (agentId) =>
      request<null>("POST", ADMIN_ROUTES.suspendAgent.path, { id: agentId }),

    resumeAgent: (agentId) => request<null>("POST", ADMIN_ROUTES.resumeAgent.path, { id: agentId }),

    terminateAgent: (agentId) =>
      request<null>("POST", ADMIN_ROUTES.terminateAgentCmd.path, { id: agentId }),

    dispatchAgent: (req) =>
      request<DispatchResponse>("POST", ADMIN_ROUTES.dispatchAgent.path, undefined, req),

    checkHealth: () =>
      request<{
        readonly status: string;
        readonly capabilities?: {
          readonly temporal: boolean;
          readonly scheduler: boolean;
          readonly taskboard: boolean;
          readonly harness: boolean;
          readonly forge: boolean;
          readonly gateway: boolean;
          readonly nexus: boolean;
          readonly governance: boolean;
        };
      }>("GET", ADMIN_ROUTES.health.path),

    fsList: (path) =>
      request<readonly FsEntry[]>(
        "GET",
        `${ADMIN_ROUTES.fsList.path}?path=${encodeURIComponent(path)}`,
      ),

    fsRead: (path) =>
      request<string>("GET", `${ADMIN_ROUTES.fsRead.path}?path=${encodeURIComponent(path)}`),

    fsWrite: (fsPath, content) =>
      request<null>("PUT", ADMIN_ROUTES.fsWrite.path, undefined, { path: fsPath, content }),

    listDataSources: () =>
      request<readonly DataSourceSummary[]>("GET", ADMIN_ROUTES.listDataSources.path),

    approveDataSource: (name) =>
      request<null>("POST", ADMIN_ROUTES.approveDataSource.path, { name }),

    rejectDataSource: (name) => request<null>("POST", ADMIN_ROUTES.rejectDataSource.path, { name }),

    getDataSourceSchema: (name) =>
      request<Readonly<Record<string, unknown>>>("GET", ADMIN_ROUTES.getDataSourceSchema.path, {
        name,
      }),

    rescanDataSources: () =>
      request<readonly DataSourceSummary[]>("POST", ADMIN_ROUTES.rescanDataSources.path),

    // ─── Runtime views ─────────────────────────────────────────────
    getMiddlewareChain: (agentId) =>
      request<MiddlewareChain>("GET", ADMIN_ROUTES.middlewareChain.path, { id: agentId }),

    getGatewayTopology: () => request<GatewayTopology>("GET", ADMIN_ROUTES.gatewayTopology.path),

    listForgeBricks: () => request<readonly ForgeBrickView[]>("GET", ADMIN_ROUTES.forgeBricks.path),

    getForgeStats: () => request<ForgeStats>("GET", ADMIN_ROUTES.forgeStats.path),

    listForgeEvents: () =>
      request<readonly import("@koi/dashboard-types").ForgeDashboardEvent[]>(
        "GET",
        ADMIN_ROUTES.forgeEvents.path,
      ),

    // ─── Temporal orchestration ────────────────────────────────────
    getTemporalHealth: () => request<TemporalHealth>("GET", ADMIN_ROUTES.temporalHealth.path),

    listWorkflows: () =>
      request<readonly WorkflowSummary[]>("GET", ADMIN_ROUTES.temporalWorkflows.path),

    getWorkflow: (workflowId) =>
      request<WorkflowDetail>("GET", ADMIN_ROUTES.temporalWorkflow.path, { id: workflowId }),

    signalWorkflow: (workflowId, signal) =>
      request<null>("POST", ADMIN_ROUTES.temporalSignal.path, { id: workflowId }, { signal }),

    terminateWorkflow: (workflowId) =>
      request<null>("POST", ADMIN_ROUTES.temporalTerminate.path, { id: workflowId }),

    // ─── Scheduler orchestration ───────────────────────────────────
    listSchedulerTasks: () =>
      request<readonly SchedulerTaskSummary[]>("GET", ADMIN_ROUTES.schedulerTasks.path),

    getSchedulerStats: () => request<SchedulerStats>("GET", ADMIN_ROUTES.schedulerStats.path),

    listSchedules: () =>
      request<readonly CronSchedule[]>("GET", ADMIN_ROUTES.schedulerSchedules.path),

    listDeadLetters: () =>
      request<readonly SchedulerDeadLetterEntry[]>("GET", ADMIN_ROUTES.schedulerDlq.path),

    retryDeadLetter: (entryId) =>
      request<null>("POST", ADMIN_ROUTES.retryDeadLetter.path, { id: entryId }),

    pauseSchedule: (scheduleId) =>
      request<null>("POST", ADMIN_ROUTES.schedulerPause.path, { id: scheduleId }),

    resumeSchedule: (scheduleId) =>
      request<null>("POST", ADMIN_ROUTES.schedulerResume.path, { id: scheduleId }),

    // ─── TaskBoard ─────────────────────────────────────────────────
    getTaskBoardSnapshot: () =>
      request<TaskBoardSnapshot>("GET", ADMIN_ROUTES.taskBoardSnapshot.path),

    // ─── Harness ───────────────────────────────────────────────────
    getHarnessStatus: () => request<HarnessStatus>("GET", ADMIN_ROUTES.harnessStatus.path),

    listCheckpoints: () =>
      request<readonly CheckpointEntry[]>("GET", ADMIN_ROUTES.harnessCheckpoints.path),

    pauseHarness: () => request<null>("POST", ADMIN_ROUTES.harnessPause.path),

    resumeHarness: () => request<null>("POST", ADMIN_ROUTES.harnessResume.path),

    // ─── Delegation ─────────────────────────────────────────────
    listDelegations: (aid) =>
      request<readonly DelegationSummary[]>("GET", ADMIN_ROUTES.listDelegations.path, {
        agentId: aid,
      }),

    // ─── Handoffs ───────────────────────────────────────────────
    listHandoffs: (aid) =>
      request<readonly HandoffSummary[]>("GET", ADMIN_ROUTES.listHandoffs.path, { agentId: aid }),

    // ─── Scratchpad ─────────────────────────────────────────────
    listScratchpad: (groupId) => {
      const qp = groupId !== undefined ? `?groupId=${encodeURIComponent(groupId)}` : "";
      return request<readonly ScratchpadEntrySummary[]>(
        "GET",
        `${ADMIN_ROUTES.listScratchpad.path}${qp}`,
      );
    },

    readScratchpad: (path) =>
      request<ScratchpadEntryDetail>(
        "GET",
        `${ADMIN_ROUTES.readScratchpad.path}?path=${encodeURIComponent(path)}`,
      ),

    // ─── Mailbox ────────────────────────────────────────────────
    listMailbox: (aid) =>
      request<readonly AgentMessage[]>("POST", ADMIN_ROUTES.listMailbox.path, { agentId: aid }),

    // ─── Governance ─────────────────────────────────────────────
    listGovernanceQueue: () =>
      request<readonly GovernancePendingItem[]>("GET", ADMIN_ROUTES.governanceQueue.path),

    reviewGovernance: (id, decision, reason) =>
      request<null>("POST", ADMIN_ROUTES.reviewGovernance.path, { id }, { decision, reason }),

    // ─── Forge Brick Lifecycle ──────────────────────────────────
    promoteBrick: (brickId) =>
      request<null>("POST", ADMIN_ROUTES.promoteBrick.path, { id: brickId }),

    demoteBrick: (brickId) => request<null>("POST", ADMIN_ROUTES.demoteBrick.path, { id: brickId }),

    quarantineBrick: (brickId) =>
      request<null>("POST", ADMIN_ROUTES.quarantineBrick.path, { id: brickId }),

    eventsUrl: () => url(ADMIN_ROUTES.events.path),

    agentChatUrl: (agentId) => url(ADMIN_ROUTES.agentChat.path, { id: agentId }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Type guard for ApiResult envelope. */
function isApiResult(json: unknown): json is ApiResult<unknown> {
  if (typeof json !== "object" || json === null) return false;
  const obj = json as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return false;
  if (obj.ok === true) return "data" in obj;
  if (obj.ok === false) {
    const err = obj.error;
    return (
      typeof err === "object" &&
      err !== null &&
      typeof (err as Record<string, unknown>).code === "string" &&
      typeof (err as Record<string, unknown>).message === "string"
    );
  }
  return false;
}

/** Map a fetch error to a DashboardClientError. */
function mapFetchError<T>(error: unknown, fetchUrl: string, timeoutMs: number): ClientResult<T> {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      error: { kind: "timeout", operation: "fetch", ms: timeoutMs },
    };
  }

  if (error instanceof TypeError) {
    return {
      ok: false,
      error: { kind: "connection_refused", url: fetchUrl },
    };
  }

  return {
    ok: false,
    error: { kind: "unexpected", cause: error },
  };
}
