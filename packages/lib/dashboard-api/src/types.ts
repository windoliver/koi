import type { AgentId, KoiError, Result, SessionId } from "@koi/core";
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

/** Convenience alias: `T` or a `Promise<T>` — async-by-default boundary. */
export type MaybeAsync<T> = T | Promise<T>;

/**
 * Storage abstraction the dashboard-api routes through. Implementations live
 * outside this package (see `@koi/runtime`'s adapter to `@koi/event-trace` and
 * `@koi/agent-monitor`).
 *
 * **Error model.** Methods return `Result<T, KoiError>`:
 * - `{ ok: true, value }` carries the success payload. `value` may itself be
 *   `undefined` / `false` for the not-found / no-op happy paths.
 * - `{ ok: false, error }` carries a structured `KoiError` whose `code`
 *   maps to a stable HTTP status (`UNAVAILABLE`→503, `TIMEOUT`→504,
 *   `RATE_LIMIT`→429, etc.) and whose `retryable` / `retryAfterMs` fields
 *   propagate to the client envelope. Adapters are responsible for
 *   sanitizing `error.message` and `error.context` before returning —
 *   anything in those fields reaches the wire verbatim. The API package
 *   strips `cause` defensively but does not redact the message.
 *
 * Thrown values from a method are reserved for *bugs*, not for signaling
 * backend failures. The catch-all surfaces them as opaque 500 INTERNAL with
 * no classification, no client-visible text, and no log of the cause body.
 *
 * All methods may return synchronously or via `Promise` — callers always await.
 */
export interface DashboardDataSource {
  listAgents(query: AgentListQuery): MaybeAsync<Result<Page<AgentStatus>, KoiError>>;
  getAgent(id: AgentId): MaybeAsync<Result<AgentStatus | undefined, KoiError>>;
  terminateAgent(id: AgentId): MaybeAsync<Result<boolean, KoiError>>;
  listSessions(query: SessionListQuery): MaybeAsync<Result<Page<SessionSummary>, KoiError>>;
  getSession(id: SessionId): MaybeAsync<Result<SessionSummary | undefined, KoiError>>;
  listMetrics(query: MetricListQuery): MaybeAsync<Result<readonly MetricPoint[], KoiError>>;
  listTraces(query: TraceListQuery): MaybeAsync<Result<Page<TraceView>, KoiError>>;
  getTrace(id: string): MaybeAsync<Result<TraceView | undefined, KoiError>>;
  /**
   * Register a callback that receives every emitted event.
   * Returns an unsubscribe function — must be safe to call multiple times.
   */
  subscribe(callback: (event: WsEvent) => void): () => void;
}

/** Static configuration for `createDashboardApi`. */
export interface DashboardApiConfig {
  readonly source: DashboardDataSource;
  /**
   * Bearer token. Required for any authed endpoint to succeed.
   * Typed as `string | undefined` so callers can pass `process.env.X`
   * (which is `string | undefined`) without a cast — when the value is
   * empty or undefined, every authed endpoint returns 503 `UNAVAILABLE`
   * (fail closed). Set this explicitly in production.
   */
  readonly authToken: string | undefined;
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
