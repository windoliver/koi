/**
 * Shared route constants for the admin API.
 *
 * Both @koi/dashboard-api (server) and @koi/tui (client) import these
 * to eliminate URL drift across the HTTP boundary.
 *
 * Paths are relative to the API prefix (default: "/admin/api").
 */

/** HTTP method type. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** A typed route definition. */
export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
}

/**
 * All admin API routes.
 *
 * Path params are encoded as `:param` (e.g., `/agents/:id`).
 * The client is responsible for interpolating actual values.
 */
export const ADMIN_ROUTES = {
  // ─── Health ──────────────────────────────────────────────────────
  health: { method: "GET", path: "/health" },

  // ─── Agents ──────────────────────────────────────────────────────
  listAgents: { method: "GET", path: "/agents" },
  getAgent: { method: "GET", path: "/agents/:id" },
  terminateAgent: { method: "POST", path: "/agents/:id/terminate" },

  // ─── Channels ────────────────────────────────────────────────────
  listChannels: { method: "GET", path: "/channels" },

  // ─── Skills ──────────────────────────────────────────────────────
  listSkills: { method: "GET", path: "/skills" },

  // ─── Metrics ─────────────────────────────────────────────────────
  getMetrics: { method: "GET", path: "/metrics" },

  // ─── Commands ────────────────────────────────────────────────────
  dispatchAgent: { method: "POST", path: "/cmd/agents/dispatch" },
  suspendAgent: { method: "POST", path: "/cmd/agents/:id/suspend" },
  resumeAgent: { method: "POST", path: "/cmd/agents/:id/resume" },
  terminateAgentCmd: { method: "POST", path: "/cmd/agents/:id/terminate" },
  retryDeadLetter: { method: "POST", path: "/cmd/events/dlq/:id/retry" },
  listMailbox: { method: "POST", path: "/cmd/mailbox/:agentId/list" },

  // ─── Runtime Views ───────────────────────────────────────────────
  processTree: { method: "GET", path: "/view/agents/tree" },
  agentProcfs: { method: "GET", path: "/view/agents/:id/procfs" },
  middlewareChain: { method: "GET", path: "/view/middleware/:id" },
  gatewayTopology: { method: "GET", path: "/view/gateway/topology" },

  // ─── Forge Views ───────────────────────────────────────────────
  forgeBricks: { method: "GET", path: "/view/forge/bricks" },
  forgeStats: { method: "GET", path: "/view/forge/stats" },
  forgeEvents: { method: "GET", path: "/view/forge/events" },

  // ─── Data Sources ───────────────────────────────────────────────
  listDataSources: { method: "GET", path: "/data-sources" },
  approveDataSource: { method: "POST", path: "/data-sources/:name/approve" },
  rejectDataSource: { method: "POST", path: "/data-sources/:name/reject" },
  getDataSourceSchema: { method: "GET", path: "/data-sources/:name/schema" },
  rescanDataSources: { method: "POST", path: "/data-sources/rescan" },

  // ─── AG-UI Chat ─────────────────────────────────────────────────
  agentChat: { method: "POST", path: "/agents/:id/chat" },

  // ─── SSE Events ──────────────────────────────────────────────────
  events: { method: "GET", path: "/events" },

  // ─── Filesystem ──────────────────────────────────────────────────
  fsList: { method: "GET", path: "/fs/list" },
  fsRead: { method: "GET", path: "/fs/read" },
  fsWrite: { method: "PUT", path: "/fs/file" },
  fsSearch: { method: "GET", path: "/fs/search" },
  fsDelete: { method: "DELETE", path: "/fs/file" },

  // ─── Service Management ────────────────────────────────────────────
  shutdown: { method: "POST", path: "/cmd/shutdown" },
  detailedStatus: { method: "GET", path: "/status/detailed" },
  demoInit: { method: "POST", path: "/cmd/demo/init" },
  demoReset: { method: "POST", path: "/cmd/demo/reset" },
  demoPacks: { method: "GET", path: "/demo/packs" },
  deploy: { method: "POST", path: "/cmd/deploy" },
  undeploy: { method: "DELETE", path: "/cmd/deploy" },
} as const;

/** Type of the ADMIN_ROUTES object. */
export type AdminRoutes = typeof ADMIN_ROUTES;

/**
 * Interpolate path params into a route path.
 *
 * @example
 * interpolatePath("/agents/:id", { id: "agent-123" })
 * // => "/agents/agent-123"
 */
export function interpolatePath(path: string, params: Readonly<Record<string, string>>): string {
  let result = path;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`:${key}`, encodeURIComponent(value));
  }
  return result;
}
