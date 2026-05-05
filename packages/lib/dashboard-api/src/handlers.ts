import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

import {
  asAgentId,
  asSessionId,
  parseAgentList,
  parseMetricList,
  parseSessionList,
  parseTraceList,
} from "./query.js";
import type { ApiResult, DashboardApiConfig, DashboardDataSource } from "./types.js";

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});

export interface RouteContext {
  readonly source: DashboardDataSource;
  readonly config: Required<Pick<DashboardApiConfig, "defaultLimit" | "maxLimit">> & {
    readonly version: string;
    readonly capabilities: readonly string[];
  };
}

export function jsonOk<T>(value: T, status = 200): Response {
  const body: ApiResult<T> = { ok: true, value };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function jsonError(error: KoiError, status: number): Response {
  const body: ApiResult<never> = { ok: false, error };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function notFound(resource: string, id: string): Response {
  const error: KoiError = {
    code: "NOT_FOUND",
    message: `${resource} ${id} not found`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { resource, resourceId: id },
  };
  return jsonError(error, 404);
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  const error: KoiError = {
    code: "VALIDATION",
    message: `method not allowed; allowed: ${allowed.join(", ")}`,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
  return new Response(JSON.stringify({ ok: false, error } satisfies ApiResult<never>), {
    status: 405,
    headers: { ...JSON_HEADERS, Allow: allowed.join(", ") },
  });
}

// ---------------------------------------------------------------------------
// Health — unauthenticated.
// ---------------------------------------------------------------------------

export function handleHealth(ctx: RouteContext): Response {
  return jsonOk({
    ok: true,
    version: ctx.config.version,
    capabilities: ctx.config.capabilities,
  });
}

// ---------------------------------------------------------------------------
// Agents.
// ---------------------------------------------------------------------------

export async function handleListAgents(url: URL, ctx: RouteContext): Promise<Response> {
  const query = parseAgentList(url, ctx.config);
  const page = await ctx.source.listAgents(query);
  return jsonOk(page);
}

export async function handleGetAgent(id: string, ctx: RouteContext): Promise<Response> {
  const agent = await ctx.source.getAgent(asAgentId(id));
  if (agent === undefined) return notFound("agent", id);
  return jsonOk(agent);
}

export async function handleTerminateAgent(id: string, ctx: RouteContext): Promise<Response> {
  const ok = await ctx.source.terminateAgent(asAgentId(id));
  if (!ok) return notFound("agent", id);
  return jsonOk({ accepted: true }, 202);
}

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

export async function handleListSessions(url: URL, ctx: RouteContext): Promise<Response> {
  const query = parseSessionList(url, ctx.config);
  const page = await ctx.source.listSessions(query);
  return jsonOk(page);
}

export async function handleGetSession(id: string, ctx: RouteContext): Promise<Response> {
  const session = await ctx.source.getSession(asSessionId(id));
  if (session === undefined) return notFound("session", id);
  return jsonOk(session);
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------

export async function handleListMetrics(url: URL, ctx: RouteContext): Promise<Response> {
  const parsed = parseMetricList(url, ctx.config);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const points = await ctx.source.listMetrics(parsed.value);
  return jsonOk({ points });
}

// ---------------------------------------------------------------------------
// Traces.
// ---------------------------------------------------------------------------

export async function handleListTraces(url: URL, ctx: RouteContext): Promise<Response> {
  const parsed = parseTraceList(url, ctx.config);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const page = await ctx.source.listTraces(parsed.value);
  return jsonOk(page);
}

export async function handleGetTrace(id: string, ctx: RouteContext): Promise<Response> {
  const trace = await ctx.source.getTrace(id);
  if (trace === undefined) return notFound("trace", id);
  return jsonOk(trace);
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Convert a typed `Result` into either the value or a 400 error response. */
export function unwrapOrFail<T>(result: Result<T, KoiError>): Result<T, Response> {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, error: jsonError(result.error, 400) };
}
