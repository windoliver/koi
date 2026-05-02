import type { AgentStatus } from "./agent-status.js";
import type { MetricPoint } from "./metric-point.js";
import type { SessionSummary } from "./session-summary.js";
import type { TraceView } from "./trace-view.js";

/** Topics a client may subscribe to. Adding a topic is a wire-protocol change — bump `v`. */
export type WsTopic = "agent-status" | "session-summary" | "metric" | "trace";

/** Client → server: subscribe to a topic set. `v` pins the protocol version. */
export interface WsSubscribe {
  readonly v: 1;
  readonly kind: "subscribe";
  readonly topics: readonly WsTopic[];
}

/** Client → server: unsubscribe from a topic set. */
export interface WsUnsubscribe {
  readonly v: 1;
  readonly kind: "unsubscribe";
  readonly topics: readonly WsTopic[];
}

export type WsClientFrame = WsSubscribe | WsUnsubscribe;

/** Server → client: one event on the `agent-status` topic. */
export interface AgentStatusEvent {
  readonly v: 1;
  readonly kind: "agent-status";
  readonly status: AgentStatus;
}

/** Server → client: one event on the `session-summary` topic. */
export interface SessionEvent {
  readonly v: 1;
  readonly kind: "session-summary";
  readonly session: SessionSummary;
}

/** Server → client: one or more samples on the `metric` topic. */
export interface MetricEvent {
  readonly v: 1;
  readonly kind: "metric";
  readonly points: readonly MetricPoint[];
}

/** Server → client: a fully-built trace on the `trace` topic. */
export interface TraceEvent {
  readonly v: 1;
  readonly kind: "trace";
  readonly trace: TraceView;
}

export type WsEvent = AgentStatusEvent | SessionEvent | MetricEvent | TraceEvent;

// ---------------------------------------------------------------------------
// Type guards (the only runtime code in this package).
// Pure inspectors over unknown JSON; safe at the trust boundary.
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "agent-status",
  "session-summary",
  "metric",
  "trace",
]);

function isObject(x: unknown): x is Readonly<Record<string, unknown>> {
  return typeof x === "object" && x !== null;
}

export function isWsEvent(x: unknown): x is WsEvent {
  if (!isObject(x)) return false;
  if (x.v !== 1) return false;
  const kind = x.kind;
  return typeof kind === "string" && KNOWN_KINDS.has(kind);
}

export function isAgentStatusEvent(x: unknown): x is AgentStatusEvent {
  return isWsEvent(x) && x.kind === "agent-status";
}

export function isSessionEvent(x: unknown): x is SessionEvent {
  return isWsEvent(x) && x.kind === "session-summary";
}

export function isMetricEvent(x: unknown): x is MetricEvent {
  return isWsEvent(x) && x.kind === "metric";
}

export function isTraceEvent(x: unknown): x is TraceEvent {
  return isWsEvent(x) && x.kind === "trace";
}
