/**
 * createDashboardHandler — main factory for the dashboard HTTP handler.
 *
 * Returns a composable handler that returns `Response | null`.
 * Null means the request didn't match any dashboard route,
 * allowing the consumer to chain with other handlers.
 */

import type { DashboardConfig, DashboardDataSource } from "@koi/dashboard-types";
import { DEFAULT_DASHBOARD_CONFIG } from "@koi/dashboard-types";
import { applyCors, getCorsHeaders, handlePreflight } from "./middleware/cors.js";
import type { RouteParams } from "./router.js";
import { createRouter, errorResponse } from "./router.js";
import { handleGetAgent, handleListAgents, handleTerminateAgent } from "./routes/agents.js";
import { handleChannels } from "./routes/channels.js";
import { handleHealth } from "./routes/health.js";
import { handleMetrics } from "./routes/metrics.js";
import { handleSkills } from "./routes/skills.js";
import { createSseProducer } from "./sse/producer.js";
import { createStaticServe } from "./static-serve.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardHandlerResult {
  readonly handler: (req: Request) => Promise<Response | null>;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDashboardHandler(
  dataSource: DashboardDataSource,
  config?: DashboardConfig,
): DashboardHandlerResult {
  const basePath = config?.basePath ?? DEFAULT_DASHBOARD_CONFIG.basePath;
  const apiPath = config?.apiPath ?? DEFAULT_DASHBOARD_CONFIG.apiPath;
  const enableCors = config?.cors ?? DEFAULT_DASHBOARD_CONFIG.cors;
  const batchIntervalMs = config?.sseBatchIntervalMs ?? DEFAULT_DASHBOARD_CONFIG.sseBatchIntervalMs;
  const maxConnections = config?.maxSseConnections ?? DEFAULT_DASHBOARD_CONFIG.maxSseConnections;

  // SSE producer
  const sseProducer = createSseProducer(dataSource, {
    batchIntervalMs,
    maxConnections,
  });

  // Static asset serving (optional)
  const staticServe =
    config?.assetsDir !== undefined ? createStaticServe(config.assetsDir) : undefined;

  // Bind data source to route handlers
  const boundRoutes = createRouter([
    {
      method: "GET",
      pattern: "/health",
      handler: (_req: Request, _params: RouteParams) => handleHealth(),
    },
    {
      method: "GET",
      pattern: "/agents",
      handler: (req: Request, params: RouteParams) => handleListAgents(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/agents/:id",
      handler: (req: Request, params: RouteParams) => handleGetAgent(req, params, dataSource),
    },
    {
      method: "POST",
      pattern: "/agents/:id/terminate",
      handler: (req: Request, params: RouteParams) => handleTerminateAgent(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/channels",
      handler: (req: Request, params: RouteParams) => handleChannels(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/skills",
      handler: (req: Request, params: RouteParams) => handleSkills(req, params, dataSource),
    },
    {
      method: "GET",
      pattern: "/metrics",
      handler: (req: Request, params: RouteParams) => handleMetrics(req, params, dataSource),
    },
  ]);

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
