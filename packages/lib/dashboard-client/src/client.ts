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

const isAgentStatusList = (x: unknown): x is readonly AgentStatus[] =>
  isReadonlyArrayOf(x, isAgentStatus);
const isSessionSummaryList = (x: unknown): x is readonly SessionSummary[] =>
  isReadonlyArrayOf(x, isSessionSummary);
const isMetricPointList = (x: unknown): x is readonly MetricPoint[] =>
  isReadonlyArrayOf(x, isMetricPointValue);

import { type FetchLike, getJson } from "./http.js";
import {
  openSubscription,
  type SubscriptionHandlers,
  type Unsubscribe,
  type WsFactory,
} from "./subscribe.js";

export interface DashboardClientConfig {
  /** Base URL of the dashboard API (e.g. `http://localhost:3100`). No trailing slash. */
  readonly baseUrl: string;
  /** Optional fetch implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Optional WebSocket factory; defaults to a `globalThis.WebSocket` adapter. */
  readonly webSocket?: WsFactory;
}

export interface DashboardClient {
  listAgents(): Promise<Result<readonly AgentStatus[]>>;
  getAgent(id: AgentId): Promise<Result<AgentStatus | undefined>>;
  listSessions(): Promise<Result<readonly SessionSummary[]>>;
  getMetrics(query: MetricQuery): Promise<Result<readonly MetricPoint[]>>;
  getTrace(turnId: string): Promise<Result<TraceView | undefined>>;
  subscribe(topics: readonly WsTopic[], handlers: SubscriptionHandlers): Unsubscribe;
}

/**
 * Create a typed dashboard client. Pure factory — does no I/O until a method is called.
 */
export function createDashboardClient(config: DashboardClientConfig): DashboardClient {
  const fetchImpl = config.fetch ?? defaultFetch();
  const wsFactory = config.webSocket ?? defaultWsFactory();
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
        { allowUndefinedValue: true, validate: isAgentStatus },
      ),

    listSessions: (): Promise<Result<readonly SessionSummary[]>> =>
      getJson<readonly SessionSummary[]>(fetchImpl, `${baseUrl}/api/sessions`, {
        validate: isSessionSummaryList,
      }),

    getMetrics: (query): Promise<Result<readonly MetricPoint[]>> =>
      getJson<readonly MetricPoint[]>(
        fetchImpl,
        `${baseUrl}/api/metrics?${encodeMetricQuery(query)}`,
        { validate: isMetricPointList },
      ),

    getTrace: (turnId): Promise<Result<TraceView | undefined>> =>
      getJson<TraceView | undefined>(
        fetchImpl,
        `${baseUrl}/api/traces/${encodeURIComponent(turnId)}`,
        { allowUndefinedValue: true, validate: isTraceView },
      ),

    subscribe: (topics, handlers): Unsubscribe =>
      openSubscription(wsFactory, `${toWsUrl(baseUrl)}/api/ws`, topics, handlers),
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  return httpUrl;
}

function encodeMetricQuery(query: MetricQuery): string {
  const params = new URLSearchParams();
  for (const name of query.names) params.append("name", name);
  params.set("from", String(query.fromMs));
  params.set("to", String(query.toMs));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.tags) {
    for (const [k, v] of Object.entries(query.tags)) params.append("tag", `${k}=${v}`);
  }
  return params.toString();
}

function defaultFetch(): FetchLike {
  const f = globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("globalThis.fetch is unavailable; pass `fetch` in DashboardClientConfig");
  }
  return f.bind(globalThis);
}

function defaultWsFactory(): WsFactory {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (Ctor === undefined) {
    throw new Error(
      "globalThis.WebSocket is unavailable; pass `webSocket` in DashboardClientConfig",
    );
  }
  return (url): WebSocket => new Ctor(url);
}
