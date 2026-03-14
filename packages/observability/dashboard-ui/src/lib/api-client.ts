/**
 * REST API client — typed fetch wrapper for dashboard endpoints.
 */

import type {
  AgentProcfs,
  ApiResult,
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  GatewayTopology,
  MiddlewareChain,
  ProcessTreeSnapshot,
} from "@koi/dashboard-types";

import { getDashboardConfig } from "./dashboard-config.js";

const API_BASE = getDashboardConfig().apiPath;

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const body = (await response.json()) as ApiResult<T>;

  if (!body.ok) {
    throw new Error(body.error.message);
  }

  return body.data;
}

export function fetchAgents(): Promise<readonly DashboardAgentSummary[]> {
  return fetchApi<readonly DashboardAgentSummary[]>("/agents");
}

export function fetchAgent(agentId: string): Promise<DashboardAgentDetail> {
  return fetchApi<DashboardAgentDetail>(`/agents/${encodeURIComponent(agentId)}`);
}

export function terminateAgent(agentId: string): Promise<null> {
  return fetchApi<null>(`/agents/${encodeURIComponent(agentId)}/terminate`, {
    method: "POST",
  });
}

export function fetchChannels(): Promise<readonly DashboardChannelSummary[]> {
  return fetchApi<readonly DashboardChannelSummary[]>("/channels");
}

export function fetchSkills(): Promise<readonly DashboardSkillSummary[]> {
  return fetchApi<readonly DashboardSkillSummary[]>("/skills");
}

export function fetchMetrics(): Promise<DashboardSystemMetrics> {
  return fetchApi<DashboardSystemMetrics>("/metrics");
}

// ---------------------------------------------------------------------------
// Health / capabilities
// ---------------------------------------------------------------------------

export interface DashboardCapabilities {
  readonly fileSystem: boolean;
  readonly runtimeViews: boolean;
  readonly commands: boolean;
  readonly orchestration: {
    readonly temporal: boolean;
    readonly scheduler: boolean;
    readonly taskBoard: boolean;
    readonly harness: boolean;
  };
  /** Per-command availability — only present when commands are available. */
  readonly commandsDetail?: {
    readonly pauseHarness: boolean;
    readonly resumeHarness: boolean;
    readonly retryDlq: boolean;
    readonly pauseSchedule: boolean;
    readonly resumeSchedule: boolean;
    readonly deleteSchedule: boolean;
  };
}

export interface HealthResponse {
  readonly status: string;
  readonly uptimeMs: number;
  readonly capabilities?: DashboardCapabilities;
}

export function fetchHealth(): Promise<HealthResponse> {
  return fetchApi<HealthResponse>("/health");
}

// ---------------------------------------------------------------------------
// Filesystem endpoints
// ---------------------------------------------------------------------------

/** Entry returned by /fs/list. */
export interface FsEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size?: number;
  readonly modifiedAt?: number;
}

export function fetchFsList(
  path: string,
  options?: { readonly recursive?: boolean; readonly glob?: string },
): Promise<readonly FsEntry[]> {
  const params = new URLSearchParams({ path });
  if (options?.recursive) params.set("recursive", "true");
  if (options?.glob !== undefined) params.set("glob", options.glob);
  return fetchApi<readonly FsEntry[]>(`/fs/list?${params.toString()}`);
}

export interface FsReadResult {
  readonly content: string;
  readonly path: string;
  readonly size: number;
  readonly editable: boolean;
}

export function fetchFsRead(path: string): Promise<FsReadResult> {
  const params = new URLSearchParams({ path });
  return fetchApi<FsReadResult>(`/fs/read?${params.toString()}`);
}

export interface FsWriteResult {
  readonly path: string;
  readonly bytesWritten: number;
}

export function saveFile(path: string, content: string): Promise<FsWriteResult> {
  return fetchApi<FsWriteResult>("/fs/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

export interface FsSearchResult {
  readonly path: string;
  readonly line?: number;
  readonly snippet?: string;
}

export function fetchFsSearch(
  query: string,
  options?: {
    readonly glob?: string;
    readonly maxResults?: number;
    readonly paths?: readonly string[];
  },
): Promise<readonly FsSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (options?.glob !== undefined) params.set("glob", options.glob);
  if (options?.maxResults !== undefined) params.set("maxResults", String(options.maxResults));
  if (options?.paths !== undefined) {
    for (const p of options.paths) {
      params.append("path", p);
    }
  }
  return fetchApi<readonly FsSearchResult[]>(`/fs/search?${params.toString()}`);
}

export function deleteFsFile(path: string): Promise<null> {
  const params = new URLSearchParams({ path });
  return fetchApi<null>(`/fs/file?${params.toString()}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Runtime view endpoints
// ---------------------------------------------------------------------------

export function fetchProcessTree(): Promise<ProcessTreeSnapshot> {
  return fetchApi<ProcessTreeSnapshot>("/view/agents/tree");
}

export function fetchAgentProcfs(agentId: string): Promise<AgentProcfs> {
  return fetchApi<AgentProcfs>(`/view/agents/${encodeURIComponent(agentId)}/procfs`);
}

export function fetchMiddlewareChain(agentId: string): Promise<MiddlewareChain> {
  return fetchApi<MiddlewareChain>(`/view/middleware/${encodeURIComponent(agentId)}`);
}

export function fetchGatewayTopology(): Promise<GatewayTopology> {
  return fetchApi<GatewayTopology>("/view/gateway/topology");
}

// ---------------------------------------------------------------------------
// Forge view endpoints (self-improvement observability)
// ---------------------------------------------------------------------------

export interface ForgeBrickViewResponse {
  readonly brickId: string;
  readonly name: string;
  readonly status: "active" | "deprecated" | "promoted" | "quarantined";
  readonly fitness: number;
  readonly sampleCount: number;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

export function fetchForgeBricks(): Promise<readonly ForgeBrickViewResponse[]> {
  return fetchApi<readonly ForgeBrickViewResponse[]>("/view/forge/bricks");
}

export function fetchForgeEvents(): Promise<readonly import("@koi/dashboard-types").ForgeDashboardEvent[]> {
  return fetchApi<readonly import("@koi/dashboard-types").ForgeDashboardEvent[]>(
    "/view/forge/events",
  );
}

// ---------------------------------------------------------------------------
// Command endpoints
// ---------------------------------------------------------------------------

export function suspendAgent(agentId: string): Promise<void> {
  return fetchApi<void>(`/cmd/agents/${encodeURIComponent(agentId)}/suspend`, {
    method: "POST",
  });
}

export function resumeAgent(agentId: string): Promise<void> {
  return fetchApi<void>(`/cmd/agents/${encodeURIComponent(agentId)}/resume`, {
    method: "POST",
  });
}

export function retryDeadLetter(eventId: string): Promise<{ readonly retried: boolean }> {
  return fetchApi<{ readonly retried: boolean }>(
    `/cmd/events/dlq/${encodeURIComponent(eventId)}/retry`,
    { method: "POST" },
  );
}

export function listMailbox(agentId: string): Promise<readonly unknown[]> {
  return fetchApi<readonly unknown[]>(`/cmd/mailbox/${encodeURIComponent(agentId)}/list`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Orchestration view endpoints (Phase 2)
// ---------------------------------------------------------------------------

export function fetchTemporalHealth(): Promise<unknown> {
  return fetchApi<unknown>("/view/temporal/health");
}

export function fetchTemporalWorkflows(): Promise<readonly unknown[]> {
  return fetchApi<readonly unknown[]>("/view/temporal/workflows");
}

export function fetchTemporalWorkflow(id: string): Promise<unknown> {
  return fetchApi<unknown>(`/view/temporal/workflows/${encodeURIComponent(id)}`);
}

export function fetchSchedulerTasks(): Promise<readonly unknown[]> {
  return fetchApi<readonly unknown[]>("/view/scheduler/tasks");
}

export function fetchSchedulerStats(): Promise<unknown> {
  return fetchApi<unknown>("/view/scheduler/stats");
}

export function fetchSchedulerSchedules(): Promise<readonly unknown[]> {
  return fetchApi<readonly unknown[]>("/view/scheduler/schedules");
}

export function fetchSchedulerDlq(): Promise<readonly unknown[]> {
  return fetchApi<readonly unknown[]>("/view/scheduler/dlq");
}

export function fetchTaskBoard(): Promise<unknown> {
  return fetchApi<unknown>("/view/taskboard");
}

export function fetchHarnessStatus(): Promise<unknown> {
  return fetchApi<unknown>("/view/harness/status");
}

export function fetchHarnessCheckpoints(): Promise<readonly unknown[]> {
  return fetchApi<readonly unknown[]>("/view/harness/checkpoints");
}

// ---------------------------------------------------------------------------
// Orchestration command endpoints (Phase 2)
// ---------------------------------------------------------------------------

export function signalWorkflow(id: string, signal: string, payload?: unknown): Promise<null> {
  return fetchApi<null>(`/cmd/temporal/workflows/${encodeURIComponent(id)}/signal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signal, payload }),
  });
}

export function terminateWorkflow(id: string): Promise<null> {
  return fetchApi<null>(`/cmd/temporal/workflows/${encodeURIComponent(id)}/terminate`, {
    method: "POST",
  });
}

export function pauseSchedule(id: string): Promise<null> {
  return fetchApi<null>(`/cmd/scheduler/schedules/${encodeURIComponent(id)}/pause`, {
    method: "POST",
  });
}

export function resumeSchedule(id: string): Promise<null> {
  return fetchApi<null>(`/cmd/scheduler/schedules/${encodeURIComponent(id)}/resume`, {
    method: "POST",
  });
}

export function deleteSchedule(id: string): Promise<null> {
  return fetchApi<null>(`/cmd/scheduler/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function retrySchedulerDlq(id: string): Promise<null> {
  return fetchApi<null>(`/cmd/scheduler/dlq/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

export function pauseHarness(): Promise<null> {
  return fetchApi<null>("/cmd/harness/pause", { method: "POST" });
}

export function resumeHarness(): Promise<null> {
  return fetchApi<null>("/cmd/harness/resume", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Agent dispatch (Phase 4 — Issue #933)
// ---------------------------------------------------------------------------

import type { DispatchAgentRequest, DispatchAgentResponse } from "@koi/dashboard-types";
import { ADMIN_ROUTES, interpolatePath } from "@koi/dashboard-types";

export function dispatchAgent(request: DispatchAgentRequest): Promise<DispatchAgentResponse> {
  return fetchApi<DispatchAgentResponse>(ADMIN_ROUTES.dispatchAgent.path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

export function chatWithAgent(
  agentId: string,
  body: {
    readonly threadId: string;
    readonly runId: string;
    readonly messages: readonly {
      readonly id: string;
      readonly role: string;
      readonly content: string;
    }[];
  },
): Promise<Response> {
  const path = interpolatePath(ADMIN_ROUTES.agentChat.path, { id: agentId });
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, tools: [], context: [] }),
  });
}
