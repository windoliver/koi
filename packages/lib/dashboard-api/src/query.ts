import type { AgentId, KoiError, Result, SessionId } from "@koi/core";
import { agentId as makeAgentId, sessionId as makeSessionId, RETRYABLE_DEFAULTS } from "@koi/core";
import type { WsTopic } from "@koi/dashboard-types";

import { clampLimit } from "./pagination.js";
import type {
  AgentListQuery,
  EventSubscription,
  MetricListQuery,
  SessionListQuery,
  TraceListQuery,
} from "./types.js";

const VALID_TOPICS: ReadonlySet<WsTopic> = new Set([
  "agent-status",
  "session-summary",
  "metric",
  "trace",
]);

/**
 * Limit-clamping helpers. Each parser is total — never throws — so handlers
 * always receive a typed query value or a `Result.error` to surface to the client.
 */
export interface LimitConfig {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

export function parseAgentList(url: URL, cfg: LimitConfig): AgentListQuery {
  return {
    cursor: emptyToUndefined(url.searchParams.get("cursor")),
    limit: clampLimit(url.searchParams.get("limit"), cfg.defaultLimit, cfg.maxLimit),
    state: emptyToUndefined(url.searchParams.get("state")),
  };
}

export function parseSessionList(url: URL, cfg: LimitConfig): SessionListQuery {
  const agentIdRaw = emptyToUndefined(url.searchParams.get("agentId"));
  return {
    cursor: emptyToUndefined(url.searchParams.get("cursor")),
    limit: clampLimit(url.searchParams.get("limit"), cfg.defaultLimit, cfg.maxLimit),
    agentId: agentIdRaw === undefined ? undefined : makeAgentId(agentIdRaw),
    status: emptyToUndefined(url.searchParams.get("status")),
  };
}

export function parseMetricList(url: URL, cfg: LimitConfig): Result<MetricListQuery, KoiError> {
  const sinceResult = parseOptionalNumber(url.searchParams.get("since"), "since");
  if (!sinceResult.ok) return sinceResult;
  return {
    ok: true,
    value: {
      name: emptyToUndefined(url.searchParams.get("name")),
      sinceMs: sinceResult.value,
      limit: clampLimit(url.searchParams.get("limit"), cfg.defaultLimit, cfg.maxLimit),
    },
  };
}

export function parseTraceList(url: URL, cfg: LimitConfig): Result<TraceListQuery, KoiError> {
  const sinceResult = parseOptionalNumber(url.searchParams.get("since"), "since");
  if (!sinceResult.ok) return sinceResult;
  const agentIdRaw = emptyToUndefined(url.searchParams.get("agentId"));
  return {
    ok: true,
    value: {
      cursor: emptyToUndefined(url.searchParams.get("cursor")),
      limit: clampLimit(url.searchParams.get("limit"), cfg.defaultLimit, cfg.maxLimit),
      agentId: agentIdRaw === undefined ? undefined : makeAgentId(agentIdRaw),
      sinceMs: sinceResult.value,
    },
  };
}

export function parseEventSubscription(url: URL): EventSubscription {
  const raw = url.searchParams.get("topics");
  if (raw === null || raw.length === 0) {
    return { topics: Array.from(VALID_TOPICS) };
  }
  const requested = raw.split(",").map((s) => s.trim());
  const topics = requested.filter((t): t is WsTopic => VALID_TOPICS.has(t as WsTopic));
  return { topics };
}

/** Brand a raw path parameter as `SessionId` for downstream typing. */
export function asSessionId(raw: string): SessionId {
  return makeSessionId(raw);
}

/** Brand a raw path parameter as `AgentId` for downstream typing. */
export function asAgentId(raw: string): AgentId {
  return makeAgentId(raw);
}

function emptyToUndefined(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  return raw.length === 0 ? undefined : raw;
}

function parseOptionalNumber(
  raw: string | null,
  field: string,
): Result<number | undefined, KoiError> {
  if (raw === null || raw.length === 0) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `${field} must be a finite number`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
      context: { field, value: raw },
    };
    return { ok: false, error };
  }
  return { ok: true, value: n };
}
