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
import { statusForCode } from "./status-codes.js";
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
  // Build the wire envelope by explicit field allowlist — `cause` is never
  // exposed (may carry adapter-internal details), `context` is included only
  // if it survives JSON round-trip (drops circular refs / BigInts / Proxies).
  const body: ApiResult<never> = { ok: false, error: sanitizeError(error) };
  return new Response(safeStringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Project a `KoiError` to its client-safe field set. Drops `cause` always;
 * preserves `code`, `message`, `retryable`, and (when JSON-safe) `context`,
 * `retryAfterMs`. This is the single chokepoint between datasource-supplied
 * errors and the wire — keep it conservative.
 */
function sanitizeError(error: KoiError): KoiError {
  const safe: { -readonly [K in keyof KoiError]?: KoiError[K] } = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  if (typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)) {
    safe.retryAfterMs = error.retryAfterMs;
  }
  if (error.context !== undefined) {
    const cleaned = jsonRoundTrip(error.context);
    if (cleaned !== undefined) safe.context = cleaned;
  }
  return safe as KoiError;
}

function jsonRoundTrip<T>(value: T): T | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined;
  }
}

/**
 * JSON-stringify with a fallback. Some `KoiError.cause` values may be circular
 * or contain `BigInt`s that would throw — never let serialization failure of
 * an error response itself become an unhandled rejection. The fallback strips
 * the `cause`/`context` fields so we always emit a valid envelope.
 */
function safeStringify(body: ApiResult<unknown>): string {
  try {
    return JSON.stringify(body);
  } catch {
    if (body.ok) return JSON.stringify({ ok: true, value: null });
    const safe: ApiResult<never> = {
      ok: false,
      error: {
        code: body.error.code,
        message: body.error.message,
        retryable: body.error.retryable,
      },
    };
    return JSON.stringify(safe);
  }
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
  const result = await ctx.source.listAgents(query);
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  return jsonOk(result.value);
}

export async function handleGetAgent(id: string, ctx: RouteContext): Promise<Response> {
  const result = await ctx.source.getAgent(asAgentId(id));
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  if (result.value === undefined) return notFound("agent", id);
  return jsonOk(result.value);
}

export async function handleTerminateAgent(id: string, ctx: RouteContext): Promise<Response> {
  const result = await ctx.source.terminateAgent(asAgentId(id));
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  if (!result.value) return notFound("agent", id);
  return jsonOk({ accepted: true }, 202);
}

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

export async function handleListSessions(url: URL, ctx: RouteContext): Promise<Response> {
  const query = parseSessionList(url, ctx.config);
  const result = await ctx.source.listSessions(query);
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  return jsonOk(result.value);
}

export async function handleGetSession(id: string, ctx: RouteContext): Promise<Response> {
  const result = await ctx.source.getSession(asSessionId(id));
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  if (result.value === undefined) return notFound("session", id);
  return jsonOk(result.value);
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------

export async function handleListMetrics(url: URL, ctx: RouteContext): Promise<Response> {
  const parsed = parseMetricList(url, ctx.config);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const result = await ctx.source.listMetrics(parsed.value);
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  return jsonOk({ points: result.value });
}

// ---------------------------------------------------------------------------
// Traces.
// ---------------------------------------------------------------------------

export async function handleListTraces(url: URL, ctx: RouteContext): Promise<Response> {
  const parsed = parseTraceList(url, ctx.config);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const result = await ctx.source.listTraces(parsed.value);
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  return jsonOk(result.value);
}

export async function handleGetTrace(id: string, ctx: RouteContext): Promise<Response> {
  const result = await ctx.source.getTrace(id);
  if (!result.ok) return jsonError(result.error, statusForCode(result.error.code));
  if (result.value === undefined) return notFound("trace", id);
  return jsonOk(result.value);
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Convert a typed `Result` into either the value or a 400 error response. */
export function unwrapOrFail<T>(result: Result<T, KoiError>): Result<T, Response> {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, error: jsonError(result.error, 400) };
}
