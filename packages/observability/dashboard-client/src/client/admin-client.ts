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
