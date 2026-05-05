import type { AgentId, KoiError, SessionId } from "@koi/core";
import type {
  AgentStatus,
  MetricPoint,
  SessionSummary,
  TraceView,
  WsEvent,
  WsTopic,
} from "@koi/dashboard-types";

/**
 * Cursor-paginated page of `T`. `nextCursor` is opaque to the client —
 * the server treats it as a black box and rejects malformed values.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

/** Filter for `GET /agents`. */
export interface AgentListQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly state?: string | undefined;
}

/** Filter for `GET /sessions`. */
export interface SessionListQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly agentId?: AgentId | undefined;
  readonly status?: string | undefined;
}

/** Filter for `GET /metrics`. */
export interface MetricListQuery {
  readonly name?: string | undefined;
  readonly sinceMs?: number | undefined;
  readonly limit: number;
}

/** Filter for `GET /traces`. */
export interface TraceListQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly agentId?: AgentId | undefined;
  readonly sinceMs?: number | undefined;
}

/** Filter for SSE `/events` subscriptions. */
export interface EventSubscription {
  readonly topics: readonly WsTopic[];
}

/**
 * Storage abstraction the dashboard-api routes through. Implementations live
 * outside this package (see `@koi/runtime`'s adapter to `@koi/event-trace` and
 * `@koi/agent-monitor`).
 *
 * All methods may return synchronously or via `Promise` — callers always await.
 */
export interface DashboardDataSource {
  listAgents(query: AgentListQuery): Promise<Page<AgentStatus>> | Page<AgentStatus>;
  getAgent(id: AgentId): Promise<AgentStatus | undefined> | (AgentStatus | undefined);
  terminateAgent(id: AgentId): Promise<boolean> | boolean;
  listSessions(query: SessionListQuery): Promise<Page<SessionSummary>> | Page<SessionSummary>;
  getSession(id: SessionId): Promise<SessionSummary | undefined> | (SessionSummary | undefined);
  listMetrics(query: MetricListQuery): Promise<readonly MetricPoint[]> | readonly MetricPoint[];
  listTraces(query: TraceListQuery): Promise<Page<TraceView>> | Page<TraceView>;
  getTrace(id: string): Promise<TraceView | undefined> | (TraceView | undefined);
  /**
   * Register a callback that receives every emitted event.
   * Returns an unsubscribe function — must be safe to call multiple times.
   */
  subscribe(callback: (event: WsEvent) => void): () => void;
}

/** Static configuration for `createDashboardApi`. */
export interface DashboardApiConfig {
  readonly source: DashboardDataSource;
  /** Bearer token. Empty/undefined → 503 on every authed endpoint. */
  readonly authToken: string;
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly sseFlushMs?: number;
  readonly sseBufferLimit?: number;
}

/** Public handler returned by `createDashboardApi`. */
export interface DashboardApi {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** REST envelope mirrored from `@koi/dashboard-types`. */
export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KoiError };
