/**
 * createDashboardHandler — main factory for the dashboard HTTP handler.
 *
 * Returns a composable handler that returns `Response | null`.
 * Null means the request didn't match any dashboard route,
 * allowing the consumer to chain with other handlers.
 */

import type { FileSystemBackend } from "@koi/core";
import type {
  CommandDispatcher,
  DashboardConfig,
  DashboardDataSource,
  RuntimeViewDataSource,
} from "@koi/dashboard-types";
import { DEFAULT_DASHBOARD_CONFIG } from "@koi/dashboard-types";
import { applyCors, getCorsHeaders, handlePreflight } from "./middleware/cors.js";
import type { RouteParams } from "./router.js";
import { createRouter, errorResponse } from "./router.js";
import { handleGetAgent, handleListAgents, handleTerminateAgent } from "./routes/agents.js";
import { handleChannels } from "./routes/channels.js";
import {
  handleDispatchAgent,
  handleListMailbox,
  handleResumeAgent,
  handleRetryDeadLetter,
  handleSuspendAgent,
  handleTerminateAgentCmd,
} from "./routes/commands.js";
import type { EditablePathMatcher } from "./routes/filesystem.js";
import {
  createDefaultEditablePaths,
  handleFsDelete,
  handleFsList,
  handleFsRead,
  handleFsSearch,
  handleFsWrite,
} from "./routes/filesystem.js";
import type { DashboardCapabilities } from "./routes/health.js";
import { handleHealth } from "./routes/health.js";
import { handleMetrics } from "./routes/metrics.js";
import {
  handleDeleteSchedule,
  handleHarnessCheckpoints,
  handleHarnessStatus,
  handlePauseHarness,
  handlePauseSchedule,
  handleResumeHarness,
  handleResumeSchedule,
  handleRetrySchedulerDlq,
  handleSchedulerDlq,
  handleSchedulerSchedules,
  handleSchedulerStats,
  handleSchedulerTasks,
  handleSignalWorkflow,
  handleTaskBoard,
  handleTemporalHealth,
  handleTemporalWorkflow,
  handleTemporalWorkflows,
  handleTerminateWorkflow,
} from "./routes/orchestration.js";
import { handleSkills } from "./routes/skills.js";
import {
  handleAgentProcfs,
  handleGatewayTopology,
  handleMiddlewareChain,
  handleProcessTree,
} from "./routes/views.js";
import { createSseProducer } from "./sse/producer.js";
import { createStaticServe } from "./static-serve.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handler for AG-UI chat requests (POST /agents/:id/chat → SSE stream). */
export type AgentChatHandler = (req: Request, agentId: string) => Response | Promise<Response>;

export interface DashboardHandlerOptions {
  readonly dataSource: DashboardDataSource;
  readonly fileSystem?: FileSystemBackend;
  readonly runtimeViews?: RuntimeViewDataSource;
  readonly commands?: CommandDispatcher;
  /** Controls which file paths are writable via PUT /fs/file. Defaults to workspace paths only. */
  readonly editablePaths?: EditablePathMatcher;
  /** AG-UI chat handler for POST /agents/:id/chat. When absent, returns 501. */
  readonly agentChatHandler?: AgentChatHandler;
}

export interface DashboardHandlerResult {
  readonly handler: (req: Request) => Promise<Response | null>;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDashboardHandler(
  dataSourceOrOptions: DashboardDataSource | DashboardHandlerOptions,
  config?: DashboardConfig,
): DashboardHandlerResult {
  // Support both old and new call signatures
  const options: DashboardHandlerOptions =
    "listAgents" in dataSourceOrOptions ? { dataSource: dataSourceOrOptions } : dataSourceOrOptions;

  const { dataSource, fileSystem, runtimeViews, commands, agentChatHandler } = options;
  const editablePaths =
    options.editablePaths ?? (fileSystem !== undefined ? createDefaultEditablePaths() : undefined);

  const basePath = config?.basePath ?? DEFAULT_DASHBOARD_CONFIG.basePath;
  const apiPath = config?.apiPath ?? DEFAULT_DASHBOARD_CONFIG.apiPath;
  const enableCors = config?.cors ?? DEFAULT_DASHBOARD_CONFIG.cors;
  const batchIntervalMs = config?.sseBatchIntervalMs ?? DEFAULT_DASHBOARD_CONFIG.sseBatchIntervalMs;
  const maxConnections = config?.maxSseConnections ?? DEFAULT_DASHBOARD_CONFIG.maxSseConnections;

  // Compute capabilities from provided options (per-subsystem granularity)
  const capabilities: DashboardCapabilities = {
    fileSystem: fileSystem !== undefined,
    runtimeViews: runtimeViews !== undefined,
    commands: commands !== undefined,
    orchestration: {
      temporal: runtimeViews?.temporal !== undefined,
      scheduler: runtimeViews?.scheduler !== undefined,
      taskBoard: runtimeViews?.taskBoard !== undefined,
      harness: runtimeViews?.harness !== undefined,
    },
    ...(commands !== undefined
      ? {
          commandsDetail: {
            pauseHarness: commands.pauseHarness !== undefined,
            resumeHarness: commands.resumeHarness !== undefined,
            retryDlq: commands.retrySchedulerDeadLetter !== undefined,
            pauseSchedule: commands.pauseSchedule !== undefined,
            resumeSchedule: commands.resumeSchedule !== undefined,
            deleteSchedule: commands.deleteSchedule !== undefined,
          },
        }
      : {}),
  };

  // SSE producer
  const sseProducer = createSseProducer(dataSource, {
    batchIntervalMs,
    maxConnections,
  });

  // Static asset serving (optional)
  const staticServe =
    config?.assetsDir !== undefined ? createStaticServe(config.assetsDir) : undefined;

  // Build route list — core routes always present, new routes conditional
  const routes: Array<{
    readonly method: string;
    readonly pattern: string;
    readonly handler: (req: Request, params: RouteParams) => Response | Promise<Response>;
  }> = [
    // Core routes (always available)
    { method: "GET", pattern: "/health", handler: (_req, _params) => handleHealth(capabilities) },
    {
      method: "GET",
      pattern: "/agents",
      handler: (req, params) => handleListAgents(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/agents/:id",
      handler: (req, params) => handleGetAgent(req, params, dataSource),
    },
    {
      method: "POST",
      pattern: "/agents/:id/terminate",
      handler: (req, params) => handleTerminateAgent(req, params, dataSource),
    },
    // AG-UI chat endpoint (returns SSE stream or 501 when no handler configured)
    {
      method: "POST",
      pattern: "/agents/:id/chat",
      handler: (req, params) => {
        if (agentChatHandler === undefined) {
          return errorResponse(
            "NOT_IMPLEMENTED",
            "AG-UI chat not configured — provide agentChatHandler to enable",
            501,
          );
        }
        const agentId = params.id;
        if (agentId === undefined) {
          return errorResponse("VALIDATION", "Missing agent ID", 400);
        }
        return agentChatHandler(req, agentId);
      },
    },
    {
      method: "GET",
      pattern: "/channels",
      handler: (req, params) => handleChannels(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/skills",
      handler: (req, params) => handleSkills(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/metrics",
      handler: (req, params) => handleMetrics(req, params, dataSource),
    },
  ];

  // Filesystem routes (when FileSystemBackend is provided)
  if (fileSystem !== undefined) {
    routes.push(
      {
        method: "GET",
        pattern: "/fs/list",
        handler: (req, params) => handleFsList(req, params, fileSystem),
      },
      {
        method: "GET",
        pattern: "/fs/read",
        handler: (req, params) => handleFsRead(req, params, fileSystem, editablePaths),
      },
      {
        method: "GET",
        pattern: "/fs/search",
        handler: (req, params) => handleFsSearch(req, params, fileSystem),
      },
      {
        method: "PUT",
        pattern: "/fs/file",
        handler: (req, params) => handleFsWrite(req, params, fileSystem, editablePaths),
      },
      {
        method: "DELETE",
        pattern: "/fs/file",
        handler: (req, params) => handleFsDelete(req, params, fileSystem, editablePaths),
      },
    );
  }

  // Runtime view routes (when RuntimeViewDataSource is provided)
  if (runtimeViews !== undefined) {
    routes.push(
      {
        method: "GET",
        pattern: "/view/agents/tree",
        handler: (req, params) => handleProcessTree(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/agents/:id/procfs",
        handler: (req, params) => handleAgentProcfs(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/middleware/:id",
        handler: (req, params) => handleMiddlewareChain(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/gateway/topology",
        handler: (req, params) => handleGatewayTopology(req, params, runtimeViews),
      },
    );

    // Orchestration views (Phase 2 — registered when runtimeViews provided)
    routes.push(
      {
        method: "GET",
        pattern: "/view/temporal/health",
        handler: (req, params) => handleTemporalHealth(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/temporal/workflows",
        handler: (req, params) => handleTemporalWorkflows(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/temporal/workflows/:id",
        handler: (req, params) => handleTemporalWorkflow(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/scheduler/tasks",
        handler: (req, params) => handleSchedulerTasks(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/scheduler/stats",
        handler: (req, params) => handleSchedulerStats(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/scheduler/schedules",
        handler: (req, params) => handleSchedulerSchedules(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/scheduler/dlq",
        handler: (req, params) => handleSchedulerDlq(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/taskboard",
        handler: (req, params) => handleTaskBoard(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/harness/status",
        handler: (req, params) => handleHarnessStatus(req, params, runtimeViews),
      },
      {
        method: "GET",
        pattern: "/view/harness/checkpoints",
        handler: (req, params) => handleHarnessCheckpoints(req, params, runtimeViews),
      },
    );
  }

  // Command routes (when CommandDispatcher is provided)
  if (commands !== undefined) {
    routes.push(
      {
        method: "POST",
        pattern: "/cmd/agents/dispatch",
        handler: (req, params) => handleDispatchAgent(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/agents/:id/suspend",
        handler: (req, params) => handleSuspendAgent(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/agents/:id/resume",
        handler: (req, params) => handleResumeAgent(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/agents/:id/terminate",
        handler: (req, params) => handleTerminateAgentCmd(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/events/dlq/:id/retry",
        handler: (req, params) => handleRetryDeadLetter(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/mailbox/:agentId/list",
        handler: (req, params) => handleListMailbox(req, params, commands),
      },
    );

    // Orchestration commands (Phase 2)
    routes.push(
      {
        method: "POST",
        pattern: "/cmd/temporal/workflows/:id/signal",
        handler: (req, params) => handleSignalWorkflow(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/temporal/workflows/:id/terminate",
        handler: (req, params) => handleTerminateWorkflow(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/scheduler/schedules/:id/pause",
        handler: (req, params) => handlePauseSchedule(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/scheduler/schedules/:id/resume",
        handler: (req, params) => handleResumeSchedule(req, params, commands),
      },
      {
        method: "DELETE",
        pattern: "/cmd/scheduler/schedules/:id",
        handler: (req, params) => handleDeleteSchedule(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/scheduler/dlq/:id/retry",
        handler: (req, params) => handleRetrySchedulerDlq(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/harness/pause",
        handler: (req, params) => handlePauseHarness(req, params, commands),
      },
      {
        method: "POST",
        pattern: "/cmd/harness/resume",
        handler: (req, params) => handleResumeHarness(req, params, commands),
      },
    );
  }

  const boundRoutes = createRouter(routes);

  /** Check that pathname starts with prefix at a path boundary (next char is "/" or end). */
  function matchesPathPrefix(pathname: string, prefix: string): boolean {
    if (!pathname.startsWith(prefix)) return false;
    const next = pathname[prefix.length];
    return next === undefined || next === "/" || prefix.endsWith("/");
  }

  const rawHandler = async (req: Request, pathname: string): Promise<Response | null> => {
    // Handle CORS preflight
    if (enableCors && req.method === "OPTIONS" && matchesPathPrefix(pathname, apiPath)) {
      return handlePreflight();
    }

    // API routes
    if (matchesPathPrefix(pathname, apiPath)) {
      const apiSubpath = pathname.slice(apiPath.length);

      // SSE events endpoint — inject CORS headers directly to avoid re-wrapping stream
      if (req.method === "GET" && apiSubpath === "/events") {
        const corsHeaders = enableCors ? getCorsHeaders() : undefined;
        return sseProducer.connect(req, corsHeaders);
      }

      // REST routes
      const match = boundRoutes.match(req.method, apiSubpath);
      if (match !== undefined) {
        return match.handler(req, match.params);
      }

      return errorResponse("NOT_FOUND", `No route for ${req.method} ${pathname}`, 404);
    }

    // Static assets (if assetsDir configured)
    if (staticServe !== undefined && matchesPathPrefix(pathname, basePath)) {
      const assetPath = pathname.slice(basePath.length) || "/index.html";

      const response = await staticServe.serve(assetPath);
      if (response !== null) return response;

      // SPA fallback — serve index.html for non-file paths
      if (!assetPath.includes(".")) {
        return staticServe.serve("/index.html");
      }
    }

    // Not a dashboard request
    return null;
  };

  const handler = async (req: Request): Promise<Response | null> => {
    const pathname = new URL(req.url).pathname;

    // Only handle dashboard paths
    if (!matchesPathPrefix(pathname, apiPath) && !matchesPathPrefix(pathname, basePath)) {
      return null;
    }

    // SSE responses already have CORS headers injected — skip re-wrapping
    const isSse = pathname === `${apiPath}/events` && req.method === "GET";

    try {
      const result = await rawHandler(req, pathname);
      if (result === null) {
        return errorResponse("NOT_FOUND", "Not found", 404);
      }
      return enableCors && !isSse ? applyCors(result) : result;
    } catch (e: unknown) {
      console.error("[dashboard-api] Unhandled error:", e);
      return errorResponse("INTERNAL", "Internal server error", 500);
    }
  };

  const dispose = (): void => {
    sseProducer.dispose();
  };

  return { handler, dispose };
}
