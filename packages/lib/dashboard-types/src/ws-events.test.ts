import { describe, expect, test } from "bun:test";
import {
  isAgentStatusEvent,
  isMetricEvent,
  isSessionEvent,
  isTraceEvent,
  isWsEvent,
} from "./ws-events.js";

describe("isWsEvent", () => {
  test("accepts a well-formed v1 event", () => {
    expect(isWsEvent({ v: 1, kind: "metric", points: [] })).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(isWsEvent({ v: 1, kind: "no-such-topic" })).toBe(false);
  });

  test("rejects wrong protocol version", () => {
    expect(isWsEvent({ v: 2, kind: "metric", points: [] })).toBe(false);
  });

  test("rejects null and primitives", () => {
    expect(isWsEvent(null)).toBe(false);
    expect(isWsEvent(undefined)).toBe(false);
    expect(isWsEvent("metric")).toBe(false);
    expect(isWsEvent(42)).toBe(false);
  });

  test("rejects missing kind field", () => {
    expect(isWsEvent({ v: 1 })).toBe(false);
  });
});

describe("topic-specific guards", () => {
  test("each guard matches only its kind", () => {
    const agentStatus = { v: 1, kind: "agent-status", status: {} };
    const session = { v: 1, kind: "session-summary", session: {} };
    const metric = { v: 1, kind: "metric", points: [] };
    const trace = { v: 1, kind: "trace", trace: {} };

    expect(isAgentStatusEvent(agentStatus)).toBe(true);
    expect(isAgentStatusEvent(session)).toBe(false);

    expect(isSessionEvent(session)).toBe(true);
    expect(isSessionEvent(metric)).toBe(false);

    expect(isMetricEvent(metric)).toBe(true);
    expect(isMetricEvent(trace)).toBe(false);

    expect(isTraceEvent(trace)).toBe(true);
    expect(isTraceEvent(agentStatus)).toBe(false);
  });

  test("guards reject malformed input shape", () => {
    expect(isAgentStatusEvent({ v: 1, kind: "metric" })).toBe(false);
    expect(isMetricEvent({ kind: "metric" })).toBe(false);
  });
});
