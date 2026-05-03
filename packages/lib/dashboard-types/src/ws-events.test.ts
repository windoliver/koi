import { describe, expect, test } from "bun:test";
import {
  isAgentStatusEvent,
  isMetricEvent,
  isSessionEvent,
  isTraceEvent,
  isWsEvent,
} from "./ws-events.js";

const wellFormedAgentStatus = {
  agentId: "a1",
  name: "alpha",
  state: "running",
  agentType: "copilot",
  channels: [],
  turns: 0,
  tokenCount: 0,
  startedAt: 1,
  lastActivityAt: 1,
  childCount: 0,
};

const wellFormedSession = {
  sessionId: "s1",
  agentId: "a1",
  status: "active",
  turns: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  startedAt: 1,
};

const wellFormedMetricPoint = { name: "cpu", value: 42, timestampMs: 1000 };

const wellFormedSpan = {
  spanId: "r",
  name: "turn",
  category: "model",
  startedAtMs: 1,
  durationMs: 100,
  children: [],
};

const wellFormedTrace = {
  turnId: "t1",
  agentId: "a1",
  turnIndex: 0,
  startedAtMs: 1,
  totalDurationMs: 100,
  root: wellFormedSpan,
};

describe("isWsEvent", () => {
  test("accepts a well-formed v1 metric event", () => {
    expect(isWsEvent({ v: 1, kind: "metric", points: [wellFormedMetricPoint] })).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(isWsEvent({ v: 1, kind: "no-such-topic" })).toBe(false);
  });

  test("rejects wrong protocol version", () => {
    expect(isWsEvent({ v: 2, kind: "metric", points: [wellFormedMetricPoint] })).toBe(false);
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

  test("rejects metric frame with missing points array", () => {
    expect(isWsEvent({ v: 1, kind: "metric" })).toBe(false);
  });

  test("rejects metric frame with malformed point", () => {
    expect(isWsEvent({ v: 1, kind: "metric", points: [{ name: "cpu" }] })).toBe(false);
  });

  test("rejects trace frame with empty trace payload", () => {
    expect(isWsEvent({ v: 1, kind: "trace", trace: {} })).toBe(false);
  });

  test("rejects trace frame with malformed root span", () => {
    expect(
      isWsEvent({
        v: 1,
        kind: "trace",
        trace: { ...wellFormedTrace, root: { spanId: "r" } },
      }),
    ).toBe(false);
  });

  test("rejects trace frame with bad child span (recursive)", () => {
    expect(
      isWsEvent({
        v: 1,
        kind: "trace",
        trace: {
          ...wellFormedTrace,
          root: { ...wellFormedSpan, children: [{ name: "bad" }] },
        },
      }),
    ).toBe(false);
  });

  test("rejects extremely deep trace tree without crashing (DoS guard)", () => {
    let node: Record<string, unknown> = { ...wellFormedSpan, children: [] };
    for (let i = 0; i < 5000; i++) {
      node = { ...wellFormedSpan, children: [node] };
    }
    expect(isWsEvent({ v: 1, kind: "trace", trace: { ...wellFormedTrace, root: node } })).toBe(
      false,
    );
  });

  test("accepts a moderately nested trace tree", () => {
    let node: Record<string, unknown> = { ...wellFormedSpan, children: [] };
    for (let i = 0; i < 50; i++) {
      node = { ...wellFormedSpan, children: [node] };
    }
    expect(isWsEvent({ v: 1, kind: "trace", trace: { ...wellFormedTrace, root: node } })).toBe(
      true,
    );
  });

  test("accepts unknown but stringly-typed span category (additive forward-compat)", () => {
    expect(
      isWsEvent({
        v: 1,
        kind: "trace",
        trace: { ...wellFormedTrace, root: { ...wellFormedSpan, category: "future-kind" } },
      }),
    ).toBe(true);
  });

  test("rejects trace frame with non-string span category", () => {
    expect(
      isWsEvent({
        v: 1,
        kind: "trace",
        trace: { ...wellFormedTrace, root: { ...wellFormedSpan, category: 42 } },
      }),
    ).toBe(false);
  });

  test("rejects agent-status frame with empty status payload", () => {
    expect(isWsEvent({ v: 1, kind: "agent-status", status: {} })).toBe(false);
  });
});

describe("topic-specific guards", () => {
  test("each guard accepts a well-formed payload of its kind", () => {
    expect(isAgentStatusEvent({ v: 1, kind: "agent-status", status: wellFormedAgentStatus })).toBe(
      true,
    );
    expect(isSessionEvent({ v: 1, kind: "session-summary", session: wellFormedSession })).toBe(
      true,
    );
    expect(isMetricEvent({ v: 1, kind: "metric", points: [wellFormedMetricPoint] })).toBe(true);
    expect(isTraceEvent({ v: 1, kind: "trace", trace: wellFormedTrace })).toBe(true);
  });

  test("guards reject malformed nested payload fields", () => {
    expect(
      isAgentStatusEvent({
        v: 1,
        kind: "agent-status",
        status: { ...wellFormedAgentStatus, agentId: 42 },
      }),
    ).toBe(false);
    expect(
      isSessionEvent({
        v: 1,
        kind: "session-summary",
        session: { ...wellFormedSession, costUsd: "free" },
      }),
    ).toBe(false);
    expect(isTraceEvent({ v: 1, kind: "trace", trace: { ...wellFormedTrace, root: null } })).toBe(
      false,
    );
    expect(isMetricEvent({ v: 1, kind: "metric", points: "x" })).toBe(false);
  });

  test("guards reject cross-kind frames", () => {
    expect(isAgentStatusEvent({ v: 1, kind: "session-summary", session: wellFormedSession })).toBe(
      false,
    );
    expect(isMetricEvent({ v: 1, kind: "trace", trace: wellFormedTrace })).toBe(false);
  });
});
