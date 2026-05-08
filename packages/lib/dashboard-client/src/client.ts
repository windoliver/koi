import type { AgentId, Result } from "@koi/core";
import type {
  AgentStatus,
  MetricPoint,
  MetricQuery,
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

const isAgentStatusList = (x: unknown): x is readonly AgentStatus[] =>
  isReadonlyArrayOf(x, isAgentStatus);
const isSessionSummaryList = (x: unknown): x is readonly SessionSummary[] =>
  isReadonlyArrayOf(x, isSessionSummary);
const isMetricPointList = (x: unknown): x is readonly MetricPoint[] =>
  isReadonlyArrayOf(x, isMetricPointValue);

interface TraceListPage {
  readonly items: readonly TraceView[];
  readonly nextCursor?: string | undefined;
}
const isTraceListPage = (x: unknown): x is TraceListPage => {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as { readonly items?: unknown; readonly nextCursor?: unknown };
  if (!isReadonlyArrayOf(obj.items, isTraceView)) return false;
  if (obj.nextCursor !== undefined && typeof obj.nextCursor !== "string") return false;
  return true;
};

export interface TraceListQuery {
  readonly agentId?: AgentId;
  readonly sinceMs?: number;
  readonly limit?: number;
  readonly cursor?: string;
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
  listAgents(): Promise<Result<readonly AgentStatus[]>>;
  getAgent(id: AgentId): Promise<Result<AgentStatus | undefined>>;
  listSessions(): Promise<Result<readonly SessionSummary[]>>;
  getMetrics(query: MetricQuery): Promise<Result<readonly MetricPoint[]>>;
  getTrace(turnId: string): Promise<Result<TraceView | undefined>>;
  listTraces(query?: TraceListQuery): Promise<Result<TraceListPage>>;
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
    listAgents: (): Promise<Result<readonly AgentStatus[]>> =>
      getJson<readonly AgentStatus[]>(fetchImpl, `${baseUrl}/api/agents`, {
        validate: isAgentStatusList,
      }),

    getAgent: (id): Promise<Result<AgentStatus | undefined>> =>
      getJson<AgentStatus | undefined>(
        fetchImpl,
        `${baseUrl}/api/agents/${encodeURIComponent(id)}`,
        {
          allowUndefinedValue: true,
          validate: isAgentStatus,
        },
      ),

    listSessions: (): Promise<Result<readonly SessionSummary[]>> =>
      getJson<readonly SessionSummary[]>(fetchImpl, `${baseUrl}/api/sessions`, {
        validate: isSessionSummaryList,
      }),

    getMetrics: async (query): Promise<Result<readonly MetricPoint[]>> => {
      // The dashboard-api parser only honors a single `name` plus `since`/`limit`.
      // Fan out one request per name and filter `toMs` + tag predicates client-side
      // so the SDK's `MetricQuery` contract (multi-name, range, tags, limit) is
      // honored for callers, regardless of the server's narrower parser.
      const names = query.names.length > 0 ? query.names : [undefined];
      const responses = await Promise.all(
        names.map((name) =>
          getJson<readonly MetricPoint[]>(
            fetchImpl,
            `${baseUrl}/api/metrics?${encodeSingleNameQuery(query, name)}`,
            { validate: isMetricPointList },
          ),
        ),
      );
      const collected: MetricPoint[] = [];
      for (const response of responses) {
        if (!response.ok) return response;
        for (const point of response.value) {
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

    listTraces: (query?: TraceListQuery): Promise<Result<TraceListPage>> => {
      const qs = encodeTraceListQuery(query);
      const url = qs.length > 0 ? `${baseUrl}/api/traces?${qs}` : `${baseUrl}/api/traces`;
      return getJson<TraceListPage>(fetchImpl, url, { validate: isTraceListPage });
    },

    subscribe: (topics, handlers): Unsubscribe =>
      openSubscription(sseAdapter, baseUrl, topics, handlers),
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function encodeSingleNameQuery(query: MetricQuery, name: string | undefined): string {
  const params = new URLSearchParams();
  if (name !== undefined) params.set("name", name);
  params.set("since", String(query.fromMs));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
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

function defaultFetch(): FetchLike {
  const f = globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("globalThis.fetch is unavailable; pass `fetch` in DashboardClientConfig");
  }
  return f.bind(globalThis);
}
