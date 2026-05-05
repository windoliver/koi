import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

import { checkAuth } from "./auth.js";
import {
  handleGetAgent,
  handleGetSession,
  handleGetTrace,
  handleHealth,
  handleListAgents,
  handleListMetrics,
  handleListSessions,
  handleListTraces,
  handleTerminateAgent,
  jsonError,
  methodNotAllowed,
  type RouteContext,
} from "./handlers.js";
import { matchRoute } from "./router.js";
import { DEFAULT_SSE_CONFIG, handleEvents, type SseConfig } from "./sse.js";
import type { DashboardApi, DashboardApiConfig } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UNKNOWN_VERSION = "unknown";

/**
 * Build a stateless dashboard HTTP handler. Compose into Bun.serve():
 *
 * ```
 * const api = createDashboardApi({ source, authToken: process.env.TOKEN });
 * Bun.serve({ port: 3100, fetch: api.fetch });
 * ```
 */
export function createDashboardApi(config: DashboardApiConfig): DashboardApi {
  const ctx: RouteContext = {
    source: config.source,
    config: {
      defaultLimit: config.defaultLimit ?? DEFAULT_LIMIT,
      maxLimit: config.maxLimit ?? MAX_LIMIT,
      version: config.version ?? UNKNOWN_VERSION,
      capabilities: config.capabilities ?? [],
    },
  };

  const sseConfig: SseConfig = {
    flushMs: config.sseFlushMs ?? DEFAULT_SSE_CONFIG.flushMs,
    bufferLimit: config.sseBufferLimit ?? DEFAULT_SSE_CONFIG.bufferLimit,
    heartbeatMs: DEFAULT_SSE_CONFIG.heartbeatMs,
  };

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // /health is unauthenticated.
    if (path === "/health") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      return handleHealth(ctx);
    }

    const auth = checkAuth(request, config.authToken);
    if (auth !== "ok") return authFailure(auth);

    // Static routes.
    if (path === "/agents" && method === "GET") return handleListAgents(url, ctx);
    if (path === "/sessions" && method === "GET") return handleListSessions(url, ctx);
    if (path === "/metrics" && method === "GET") return handleListMetrics(url, ctx);
    if (path === "/traces" && method === "GET") return handleListTraces(url, ctx);
    if (path === "/events" && method === "GET") {
      return handleEvents(url, config.source, sseConfig);
    }

    // Parameterised routes.
    const agentMatch = matchRoute("/agents/:id", path);
    if (agentMatch !== undefined && agentMatch.params.id !== undefined) {
      if (method === "GET") return handleGetAgent(agentMatch.params.id, ctx);
      return methodNotAllowed(["GET"]);
    }

    const terminateMatch = matchRoute("/agents/:id/terminate", path);
    if (terminateMatch !== undefined && terminateMatch.params.id !== undefined) {
      if (method === "POST") return handleTerminateAgent(terminateMatch.params.id, ctx);
      return methodNotAllowed(["POST"]);
    }

    const sessionMatch = matchRoute("/sessions/:id", path);
    if (sessionMatch !== undefined && sessionMatch.params.id !== undefined) {
      if (method === "GET") return handleGetSession(sessionMatch.params.id, ctx);
      return methodNotAllowed(["GET"]);
    }

    const traceMatch = matchRoute("/traces/:id", path);
    if (traceMatch !== undefined && traceMatch.params.id !== undefined) {
      if (method === "GET") return handleGetTrace(traceMatch.params.id, ctx);
      return methodNotAllowed(["GET"]);
    }

    return notFoundResponse(path);
  };

  return { fetch: fetchHandler };
}

function authFailure(reason: "missing" | "invalid" | "unconfigured"): Response {
  if (reason === "unconfigured") {
    const error: KoiError = {
      code: "UNAVAILABLE",
      message: "dashboard-api auth token not configured",
      retryable: RETRYABLE_DEFAULTS.UNAVAILABLE,
    };
    return jsonError(error, 503);
  }
  const error: KoiError = {
    code: "AUTH_REQUIRED",
    message: reason === "missing" ? "missing bearer token" : "invalid bearer token",
    retryable: RETRYABLE_DEFAULTS.AUTH_REQUIRED,
  };
  return jsonError(error, 401);
}

function notFoundResponse(path: string): Response {
  const error: KoiError = {
    code: "NOT_FOUND",
    message: `unknown route: ${path}`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
  };
  return jsonError(error, 404);
}
