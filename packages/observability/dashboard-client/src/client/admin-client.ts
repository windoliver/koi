/**
 * Typed HTTP client for the Koi admin API.
 *
 * All methods return Result<T, DashboardClientError> — never throw.
 * Uses ADMIN_ROUTES from @koi/dashboard-types for URL construction.
 */

import type {
  AgentProcfs,
  ApiResult,
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  DataSourceSummary,
  DemoPackSummary,
  DetailedStatusResponse,
  ProcessTreeSnapshot,
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
  readonly checkHealth: () => Promise<ClientResult<{ readonly status: string }>>;
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
  /** Build the SSE events URL for reconnecting stream. */
  readonly eventsUrl: () => string;
  /** Build the AG-UI chat URL for a specific agent. */
  readonly agentChatUrl: (agentId: string) => string;
  /** Initiate graceful shutdown. Requires X-Confirm header. */
  readonly shutdown: () => Promise<ClientResult<null>>;
  /** Get detailed subsystem status. */
  readonly detailedStatus: () => Promise<ClientResult<DetailedStatusResponse>>;
  /** Initialize a demo pack. */
  readonly demoInit: (packId: string) => Promise<ClientResult<null>>;
  /** Reset a demo pack. */
  readonly demoReset: (packId: string) => Promise<ClientResult<null>>;
  /** List available demo packs. */
  readonly demoPacks: () => Promise<ClientResult<readonly DemoPackSummary[]>>;
  /** Trigger deployment. Requires X-Confirm header. */
  readonly deploy: () => Promise<ClientResult<null>>;
  /** Undo deployment. Requires X-Confirm header. */
  readonly undeploy: () => Promise<ClientResult<null>>;
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
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<ClientResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url(path, params), {
        method,
        headers: { ...headers(), ...extraHeaders },
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

    checkHealth: () => request<{ readonly status: string }>("GET", ADMIN_ROUTES.health.path),

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

    eventsUrl: () => url(ADMIN_ROUTES.events.path),

    agentChatUrl: (agentId) => url(ADMIN_ROUTES.agentChat.path, { id: agentId }),

    shutdown: () =>
      request<null>("POST", ADMIN_ROUTES.shutdown.path, undefined, undefined, {
        "X-Confirm": "true",
      }),

    detailedStatus: () => request<DetailedStatusResponse>("GET", ADMIN_ROUTES.detailedStatus.path),

    demoInit: (packId) => request<null>("POST", ADMIN_ROUTES.demoInit.path, undefined, { packId }),

    demoReset: (packId) =>
      request<null>("POST", ADMIN_ROUTES.demoReset.path, undefined, { packId }),

    demoPacks: () => request<readonly DemoPackSummary[]>("GET", ADMIN_ROUTES.demoPacks.path),

    deploy: () =>
      request<null>("POST", ADMIN_ROUTES.deploy.path, undefined, undefined, {
        "X-Confirm": "true",
      }),

    undeploy: () =>
      request<null>("DELETE", ADMIN_ROUTES.deploy.path, undefined, undefined, {
        "X-Confirm": "true",
      }),
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
