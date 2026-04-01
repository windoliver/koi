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

  // ─── Cost Views ────────────────────────────────────────────────
  costSnapshot: { method: "GET", path: "/view/cost/snapshot" },

  // ─── Forge Views ───────────────────────────────────────────────
  forgeBricks: { method: "GET", path: "/view/forge/bricks" },
  forgeStats: { method: "GET", path: "/view/forge/stats" },
  forgeEvents: { method: "GET", path: "/view/forge/events" },

  // ─── Debug Views ─────────────────────────────────────────────
  debugInventory: { method: "GET" as const, path: "/view/debug/:id/inventory" },
  debugTrace: { method: "GET" as const, path: "/view/debug/:id/trace/:turn" },
  debugContributions: { method: "GET" as const, path: "/view/debug/contributions" },

  // ─── Temporal Orchestration ────────────────────────────────────
  temporalHealth: { method: "GET", path: "/view/temporal/health" },
  temporalWorkflows: { method: "GET", path: "/view/temporal/workflows" },
  temporalWorkflow: { method: "GET", path: "/view/temporal/workflows/:id" },
  temporalSignal: { method: "POST", path: "/cmd/temporal/workflows/:id/signal" },
  temporalTerminate: { method: "POST", path: "/cmd/temporal/workflows/:id/terminate" },

  // ─── Scheduler Orchestration ──────────────────────────────────
  schedulerTasks: { method: "GET", path: "/view/scheduler/tasks" },
  schedulerStats: { method: "GET", path: "/view/scheduler/stats" },
  schedulerSchedules: { method: "GET", path: "/view/scheduler/schedules" },
  schedulerDlq: { method: "GET", path: "/view/scheduler/dlq" },
  schedulerPause: { method: "POST", path: "/cmd/scheduler/schedules/:id/pause" },
  schedulerResume: { method: "POST", path: "/cmd/scheduler/schedules/:id/resume" },
  schedulerDeleteSchedule: { method: "DELETE", path: "/cmd/scheduler/schedules/:id" },

  // ─── TaskBoard Orchestration ──────────────────────────────────
  taskBoardSnapshot: { method: "GET", path: "/view/taskboard/snapshot" },

  // ─── Harness Orchestration ────────────────────────────────────
  harnessStatus: { method: "GET", path: "/view/harness/status" },
  harnessCheckpoints: { method: "GET", path: "/view/harness/checkpoints" },
  harnessPause: { method: "POST", path: "/cmd/harness/pause" },
  harnessResume: { method: "POST", path: "/cmd/harness/resume" },

  // ─── Delegation ─────────────────────────────────────────────────
  listDelegations: { method: "GET", path: "/view/delegations/:agentId" },

  // ─── Handoffs ───────────────────────────────────────────────────
  listHandoffs: { method: "GET", path: "/view/handoffs/:agentId" },

  // ─── Scratchpad ─────────────────────────────────────────────────
  listScratchpad: { method: "GET", path: "/view/scratchpad/list" },
  readScratchpad: { method: "GET", path: "/view/scratchpad/file" },

  // ─── Governance Queue ───────────────────────────────────────────
  governanceQueue: { method: "GET", path: "/view/governance/queue" },
  reviewGovernance: { method: "POST", path: "/cmd/governance/:id/review" },

  // ─── Forge Brick Lifecycle ──────────────────────────────────────
  promoteBrick: { method: "POST", path: "/cmd/forge/bricks/:id/promote" },
  demoteBrick: { method: "POST", path: "/cmd/forge/bricks/:id/demote" },
  quarantineBrick: { method: "POST", path: "/cmd/forge/bricks/:id/quarantine" },

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
