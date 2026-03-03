/**
 * REST API client — typed fetch wrapper for dashboard endpoints.
 */

import type {
  ApiResult,
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardSkillSummary,
  DashboardSystemMetrics,
} from "@koi/dashboard-types";

const API_BASE = "/dashboard/api";

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
