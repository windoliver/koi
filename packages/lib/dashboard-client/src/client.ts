import type { AgentId, Result } from "@koi/core";
import type {
  AgentStatus,
  MetricPoint,
  MetricQuery,
  Page,
  SessionSummary,
  TraceView,
  WsTopic,
} from "@koi/dashboard-types";
import {
  isAgentStatus,
  isMetricPointValue,
  isReadonlyArrayOf,
  isSessionSummary,
  isTraceView,
} from "@koi/dashboard-types";
import { type FetchLike, getJson } from "./http.js";
import {
  createFetchSseAdapter,
  openSubscription,
  type SseAdapter,
  type SubscriptionHandlers,
  type Unsubscribe,
  type WsFactory,
} from "./subscribe.js";

// dashboard-api wraps metric responses in { points: [...] } (unique among list
// endpoints). Accept both shapes so the SDK works against the real server and
// the existing array-shape mocks in older test fixtures.
const isMetricPointEnvelope = (
  x: unknown,
): x is readonly MetricPoint[] | { readonly points: readonly MetricPoint[] } => {
  if (isReadonlyArrayOf(x, isMetricPointValue)) return true;
  if (typeof x !== "object" || x === null) return false;
  const obj = x as { readonly points?: unknown };
  return isReadonlyArrayOf(obj.points, isMetricPointValue);
};
const unwrapMetricList = (
  v: readonly MetricPoint[] | { readonly points: readonly MetricPoint[] },
): readonly MetricPoint[] => {
  if (Array.isArray(v)) return v as readonly MetricPoint[];
  return (v as { readonly points: readonly MetricPoint[] }).points;
};

function isPageOf<T>(itemGuard: (x: unknown) => x is T) {
  return (x: unknown): x is Page<T> => {
    if (typeof x !== "object" || x === null) return false;
    const obj = x as { readonly items?: unknown; readonly nextCursor?: unknown };
    if (!isReadonlyArrayOf(obj.items, itemGuard)) return false;
    if (obj.nextCursor !== undefined && typeof obj.nextCursor !== "string") return false;
    return true;
  };
}
const isAgentStatusPage = isPageOf(isAgentStatus);
const isSessionSummaryPage = isPageOf(isSessionSummary);
const isTraceViewPage = isPageOf(isTraceView);

export interface ListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AgentListQuery extends ListQuery {
  readonly state?: string;
}

export interface SessionListQuery extends ListQuery {
  readonly agentId?: AgentId;
  readonly status?: string;
}

export interface TraceListQuery extends ListQuery {
  readonly agentId?: AgentId;
  readonly sinceMs?: number;
}

export interface DashboardClientConfig {
  /** Base URL of the dashboard API (e.g. `http://localhost:3100`). No trailing slash. */
  readonly baseUrl: string;
  /** Optional fetch implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Optional injectable SSE adapter. Defaults to the built-in fetch-backed adapter. */
  readonly sse?: SseAdapter;
  /** @deprecated Legacy field preserved for source compatibility. Ignored by the SSE client. */
  readonly webSocket?: WsFactory;
}

export interface DashboardClient {
  listAgents(query?: AgentListQuery): Promise<Result<Page<AgentStatus>>>;
  getAgent(id: AgentId): Promise<Result<AgentStatus | undefined>>;
  listSessions(query?: SessionListQuery): Promise<Result<Page<SessionSummary>>>;
  getMetrics(query: MetricQuery): Promise<Result<readonly MetricPoint[]>>;
  getTrace(turnId: string): Promise<Result<TraceView | undefined>>;
  listTraces(query?: TraceListQuery): Promise<Result<Page<TraceView>>>;
  subscribe(topics: readonly WsTopic[], handlers: SubscriptionHandlers): Unsubscribe;
}

/**
 * Create a typed dashboard client. Pure factory — does no I/O until a method is called.
 */
export function createDashboardClient(config: DashboardClientConfig): DashboardClient {
  const fetchImpl = config.fetch ?? defaultFetch();
  const sseAdapter = config.sse ?? createFetchSseAdapter(fetchImpl);
  const baseUrl = stripTrailingSlash(config.baseUrl);

  return {
    listAgents: (query?: AgentListQuery): Promise<Result<Page<AgentStatus>>> => {
      const qs = encodeAgentListQuery(query);
      const url = qs.length > 0 ? `${baseUrl}/api/agents?${qs}` : `${baseUrl}/api/agents`;
      return getJson<Page<AgentStatus>>(fetchImpl, url, { validate: isAgentStatusPage });
    },

    getAgent: (id): Promise<Result<AgentStatus | undefined>> =>
      getJson<AgentStatus | undefined>(
        fetchImpl,
        `${baseUrl}/api/agents/${encodeURIComponent(id)}`,
        {
          allowUndefinedValue: true,
          validate: isAgentStatus,
        },
      ),

    listSessions: (query?: SessionListQuery): Promise<Result<Page<SessionSummary>>> => {
      const qs = encodeSessionListQuery(query);
      const url = qs.length > 0 ? `${baseUrl}/api/sessions?${qs}` : `${baseUrl}/api/sessions`;
      return getJson<Page<SessionSummary>>(fetchImpl, url, { validate: isSessionSummaryPage });
    },

    getMetrics: async (query): Promise<Result<readonly MetricPoint[]>> => {
      // The dashboard-api parser only honors a single `name` plus `since`/`limit`.
      // Fan out one request per name and filter `toMs` + tag predicates client-side
      // so the SDK's `MetricQuery` contract (multi-name, range, tags, limit) is
      // honored for callers, regardless of the server's narrower parser.
      const names = query.names.length > 0 ? query.names : [undefined];
      const responses = await Promise.all(
        names.map((name) =>
          getJson<readonly MetricPoint[] | { readonly points: readonly MetricPoint[] }>(
            fetchImpl,
            `${baseUrl}/api/metrics?${encodeSingleNameQuery(query, name)}`,
            { validate: isMetricPointEnvelope },
          ),
        ),
      );
      const collected: MetricPoint[] = [];
      for (const response of responses) {
        if (!response.ok) return response;
        for (const point of unwrapMetricList(response.value)) {
          if (point.timestampMs < query.fromMs || point.timestampMs > query.toMs) continue;
          if (query.tags && !matchesTags(point.tags, query.tags)) continue;
          collected.push(point);
        }
      }
      // Enforce the published `limit` across the merged set so callers get the
      // bound they asked for even after fan-out. Sort newest-first so a small
      // limit reliably returns the most recent samples.
      collected.sort((left, right) => right.timestampMs - left.timestampMs);
      const bounded =
        query.limit !== undefined && collected.length > query.limit
          ? collected.slice(0, query.limit)
          : collected;
      return { ok: true, value: bounded };
    },

    getTrace: (turnId): Promise<Result<TraceView | undefined>> =>
      getJson<TraceView | undefined>(
        fetchImpl,
        `${baseUrl}/api/traces/${encodeURIComponent(turnId)}`,
        {
          allowUndefinedValue: true,
          validate: isTraceView,
        },
      ),

    listTraces: (query?: TraceListQuery): Promise<Result<Page<TraceView>>> => {
      const qs = encodeTraceListQuery(query);
      const url = qs.length > 0 ? `${baseUrl}/api/traces?${qs}` : `${baseUrl}/api/traces`;
      return getJson<Page<TraceView>>(fetchImpl, url, { validate: isTraceViewPage });
    },

    subscribe: (topics, handlers): Unsubscribe =>
      openSubscription(sseAdapter, baseUrl, topics, handlers),
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function encodeSingleNameQuery(query: MetricQuery, name: string | undefined): string {
  // Don't forward `query.limit` to the server: the server applies the limit
  // before any ordering, so passing it would truncate to the OLDEST N points
  // per name. The fan-out below sorts newest-first across all names and then
  // applies `query.limit` client-side, which is the contract callers expect.
  const params = new URLSearchParams();
  if (name !== undefined) params.set("name", name);
  params.set("since", String(query.fromMs));
  return params.toString();
}

function matchesTags(
  pointTags: Readonly<Record<string, string>> | undefined,
  predicate: Readonly<Record<string, string>>,
): boolean {
  for (const [key, value] of Object.entries(predicate)) {
    if (pointTags?.[key] !== value) return false;
  }
  return true;
}

function encodeTraceListQuery(query: TraceListQuery | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.agentId !== undefined) params.set("agentId", query.agentId);
  if (query.sinceMs !== undefined) params.set("since", String(query.sinceMs));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return params.toString();
}

function encodeAgentListQuery(query: AgentListQuery | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.state !== undefined) params.set("state", query.state);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return params.toString();
}

function encodeSessionListQuery(query: SessionListQuery | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.agentId !== undefined) params.set("agentId", query.agentId);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return params.toString();
}

function defaultFetch(): FetchLike {
  const f = globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("globalThis.fetch is unavailable; pass `fetch` in DashboardClientConfig");
  }
  return f.bind(globalThis);
}
