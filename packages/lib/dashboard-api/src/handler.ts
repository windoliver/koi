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
    try {
      return await dispatch(request, ctx, config, sseConfig);
    } catch (e: unknown) {
      // Datasource exceptions are NEVER classified across this trust boundary:
      // adapters live outside the API package and may carry sensitive
      // identifiers, ACL details, or backend-specific context in error
      // messages. The contract is to return `T | undefined` for expected
      // failures; thrown values are unexpected and become a generic 500.
      // Status-coded responses (400/401/403/404/etc.) come from explicit
      // handler logic, not from propagating thrown values.
      //
      // The catch is intentionally broad — any unexpected throw (handler bug,
      // adapter exception, malformed Request) becomes a 500. Diagnostics that
      // we trust (request method, route, Error class name) are logged; raw
      // cause text/stack is NOT, since adapter-controlled strings can carry
      // sensitive data.
      return internalErrorResponse(e, requestSummary(request));
    }
  };

  return { fetch: fetchHandler };
}

async function dispatch(
  request: Request,
  ctx: RouteContext,
  config: DashboardApiConfig,
  sseConfig: SseConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // /health is unauthenticated.
  if (path === "/health") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return handleHealth(ctx);
  }

  const auth = checkAuth(request, config.authToken ?? "");
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

function internalErrorResponse(cause: unknown, summary: RequestSummary): Response {
  // Log only sanitized primitives — a hostile thrown value (e.g. a Proxy with
  // a throwing trap) can make even `console.error(..., cause)` re-throw during
  // inspection and break the catch-all. Pull the safe fields manually.
  safeLog(cause, summary);
  const error: KoiError = {
    code: "INTERNAL",
    message: "internal server error",
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
  };
  return jsonError(error, 500);
}

interface RequestSummary {
  readonly method: string;
  readonly path: string;
}

function requestSummary(request: Request): RequestSummary {
  // Building a URL itself can throw on malformed input, but if dispatch made
  // it past `new URL(request.url)` then the request was at least URL-shaped.
  // We still guard so the catch-all is fully safe.
  let path = "<unknown>";
  try {
    path = new URL(request.url).pathname;
  } catch {
    // leave default
  }
  return { method: request.method, path };
}

function safeLog(cause: unknown, summary: RequestSummary): void {
  // Adapter-controlled error text (message, stack, context) may contain
  // tenant identifiers, ACL hints, or backend secrets. We log only fields the
  // dashboard-api package itself controls (request method, path, Error class
  // name) so operators have actionable signal without this layer becoming a
  // leak path. Adapters that need detailed failure visibility must perform
  // their own trusted logging upstream.
  try {
    const kind =
      cause instanceof Error ? cause.constructor.name : cause === null ? "null" : typeof cause;
    console.error(
      "[dashboard-api] unhandled error",
      `method=${summary.method}`,
      `path=${summary.path}`,
      `kind=${kind}`,
    );
  } catch {
    // Even the constructor lookup can throw on a hostile Proxy. Swallow —
    // the structured 500 response is still the contract we must honor.
  }
}
