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
// Pure inspectors over unknown JSON; validate required scalars per `kind`
// so consumers can trust required field access after the guard returns true.
// ---------------------------------------------------------------------------

function isObject(x: unknown): x is Readonly<Record<string, unknown>> {
  return typeof x === "object" && x !== null;
}

function hasV1(x: Readonly<Record<string, unknown>>): boolean {
  return x.v === 1;
}

function isStringArray(x: unknown): x is readonly string[] {
  return Array.isArray(x) && x.every((v): v is string => typeof v === "string");
}

function isOptional<T>(x: unknown, predicate: (v: unknown) => v is T): x is T | undefined {
  return x === undefined || predicate(x);
}

function isPlainRecord(x: unknown): x is Readonly<Record<string, unknown>> {
  return isObject(x) && !Array.isArray(x);
}

function isStringRecord(x: unknown): x is Readonly<Record<string, string>> {
  if (!isPlainRecord(x)) return false;
  for (const v of Object.values(x)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

function isAttributeValue(x: unknown): x is string | number | boolean {
  return typeof x === "string" || typeof x === "number" || typeof x === "boolean";
}

function isAttributeRecord(x: unknown): x is Readonly<Record<string, string | number | boolean>> {
  if (!isPlainRecord(x)) return false;
  for (const v of Object.values(x)) {
    if (!isAttributeValue(v)) return false;
  }
  return true;
}

/**
 * Runtime type guard for `AgentStatus`. True iff every required scalar is
 * present and well-typed. Re-exported via the package barrel so HTTP/SDK
 * decoders can use the same trust-boundary check as the WS guards.
 */
export function isAgentStatus(x: unknown): x is AgentStatus {
  return isAgentStatusPayload(x);
}

/** Runtime type guard for `SessionSummary`. */
export function isSessionSummary(x: unknown): x is SessionSummary {
  return isSessionPayload(x);
}

/** Runtime type guard for `MetricPoint`. */
export function isMetricPointValue(x: unknown): x is MetricPoint {
  return isMetricPoint(x);
}

/** Runtime type guard for `TraceView`. */
export function isTraceView(x: unknown): x is TraceView {
  return isTracePayload(x);
}

/** Element-wise array guard helper. */
export function isReadonlyArrayOf<T>(
  x: unknown,
  elementGuard: (v: unknown) => v is T,
): x is readonly T[] {
  return Array.isArray(x) && x.every(elementGuard);
}

function isAgentStatusPayload(x: unknown): boolean {
  if (!isObject(x)) return false;
  return (
    typeof x.agentId === "string" &&
    typeof x.name === "string" &&
    // Accept any string for state — forward-compat with newer servers that
    // emit additional ProcessState variants. Rendering layers gate display.
    typeof x.state === "string" &&
    // Accept any string for agentType so a v1 server can add new variants
    // additively. The caller's narrow type gates which values it renders.
    typeof x.agentType === "string" &&
    isStringArray(x.channels) &&
    typeof x.turns === "number" &&
    typeof x.tokenCount === "number" &&
    typeof x.startedAt === "number" &&
    typeof x.lastActivityAt === "number" &&
    typeof x.childCount === "number" &&
    isOptional(x.model, (v): v is string => typeof v === "string") &&
    isOptional(x.parentId, (v): v is string => typeof v === "string")
  );
}

function isSessionPayload(x: unknown): boolean {
  if (!isObject(x)) return false;
  return (
    typeof x.sessionId === "string" &&
    typeof x.agentId === "string" &&
    typeof x.status === "string" &&
    typeof x.turns === "number" &&
    typeof x.inputTokens === "number" &&
    typeof x.outputTokens === "number" &&
    typeof x.costUsd === "number" &&
    typeof x.startedAt === "number" &&
    isOptional(x.endedAt, (v): v is number => typeof v === "number")
  );
}

function isMetricPoint(x: unknown): boolean {
  if (!isObject(x)) return false;
  return (
    typeof x.name === "string" &&
    typeof x.value === "number" &&
    typeof x.timestampMs === "number" &&
    isOptional(x.tags, isStringRecord)
  );
}

/** Validation cap — well-formed traces are tens of levels deep at most. */
const MAX_SPAN_DEPTH = 256;
/** Validation cap — total spans visited; prevents wide-and-shallow DoS too. */
const MAX_SPAN_NODES = 100_000;

/**
 * Iterative validator — walks the span tree with an explicit stack so a
 * remote-supplied deep trace cannot blow the JS call stack or burn unbounded
 * CPU at the trust boundary.
 */
function isTraceSpanTree(root: unknown): boolean {
  const stack: { readonly node: unknown; readonly depth: number }[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) return false;
    if (frame.depth > MAX_SPAN_DEPTH) return false;
    if (++visited > MAX_SPAN_NODES) return false;
    const node = frame.node;
    if (!isObject(node)) return false;
    if (
      typeof node.spanId !== "string" ||
      typeof node.name !== "string" ||
      // Accept any string for category — v1 servers can add additional span
      // kinds without breaking older clients. The narrow type gates rendering.
      typeof node.category !== "string" ||
      typeof node.startedAtMs !== "number" ||
      typeof node.durationMs !== "number" ||
      !Array.isArray(node.children) ||
      !isOptional(node.error, (v): v is string => typeof v === "string") ||
      !isOptional(node.attributes, isAttributeRecord)
    ) {
      return false;
    }
    for (const child of node.children) {
      stack.push({ node: child, depth: frame.depth + 1 });
    }
  }
  return true;
}

function isTracePayload(x: unknown): boolean {
  if (!isObject(x)) return false;
  return (
    typeof x.turnId === "string" &&
    typeof x.agentId === "string" &&
    typeof x.turnIndex === "number" &&
    typeof x.startedAtMs === "number" &&
    typeof x.totalDurationMs === "number" &&
    isTraceSpanTree(x.root)
  );
}

export function isAgentStatusEvent(x: unknown): x is AgentStatusEvent {
  return isObject(x) && hasV1(x) && x.kind === "agent-status" && isAgentStatusPayload(x.status);
}

export function isSessionEvent(x: unknown): x is SessionEvent {
  return isObject(x) && hasV1(x) && x.kind === "session-summary" && isSessionPayload(x.session);
}

export function isMetricEvent(x: unknown): x is MetricEvent {
  return (
    isObject(x) &&
    hasV1(x) &&
    x.kind === "metric" &&
    Array.isArray(x.points) &&
    x.points.every(isMetricPoint)
  );
}

export function isTraceEvent(x: unknown): x is TraceEvent {
  return isObject(x) && hasV1(x) && x.kind === "trace" && isTracePayload(x.trace);
}

/**
 * True iff `x` is a fully-formed `WsEvent` — every required scalar is present
 * and well-typed, and trace span trees are fully validated recursively.
 */
export function isWsEvent(x: unknown): x is WsEvent {
  return isAgentStatusEvent(x) || isSessionEvent(x) || isMetricEvent(x) || isTraceEvent(x);
}
