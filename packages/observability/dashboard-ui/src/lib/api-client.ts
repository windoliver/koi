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

export function fetchFsRead(path: string): Promise<string> {
  const params = new URLSearchParams({ path });
  return fetchApi<string>(`/fs/read?${params.toString()}`);
}

export interface FsSearchResult {
  readonly path: string;
  readonly line?: number;
  readonly snippet?: string;
}

export function fetchFsSearch(
  query: string,
  options?: { readonly glob?: string; readonly maxResults?: number },
): Promise<readonly FsSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (options?.glob !== undefined) params.set("glob", options.glob);
  if (options?.maxResults !== undefined) params.set("maxResults", String(options.maxResults));
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
  return fetchApi<ProcessTreeSnapshot>("/view/process-tree");
}

export function fetchAgentProcfs(agentId: string): Promise<AgentProcfs> {
  return fetchApi<AgentProcfs>(`/view/procfs/${encodeURIComponent(agentId)}`);
}

export function fetchMiddlewareChain(agentId: string): Promise<MiddlewareChain> {
  return fetchApi<MiddlewareChain>(`/view/middleware/${encodeURIComponent(agentId)}`);
}

export function fetchGatewayTopology(): Promise<GatewayTopology> {
  return fetchApi<GatewayTopology>("/view/gateway");
}
