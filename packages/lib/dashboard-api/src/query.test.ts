import { describe, expect, test } from "bun:test";

import {
  parseAgentList,
  parseEventSubscription,
  parseMetricList,
  parseSessionList,
  parseTraceList,
} from "./query.js";

const CFG = { defaultLimit: 50, maxLimit: 200 } as const;

function url(qs: string): URL {
  return new URL(`http://localhost/path?${qs}`);
}

describe("parseAgentList", () => {
  test("uses defaults when query is empty", () => {
    const q = parseAgentList(url(""), CFG);
    expect(q.limit).toBe(50);
    expect(q.cursor).toBeUndefined();
    expect(q.state).toBeUndefined();
  });

  test("captures cursor + state + limit", () => {
    const q = parseAgentList(url("limit=10&cursor=abc&state=running"), CFG);
    expect(q).toEqual({ cursor: "abc", limit: 10, state: "running" });
  });

  test("clamps oversized limit", () => {
    expect(parseAgentList(url("limit=9999"), CFG).limit).toBe(200);
  });
});

describe("parseSessionList", () => {
  test("brands agentId", () => {
    const q = parseSessionList(url("agentId=ag-1&status=active"), CFG);
    expect(String(q.agentId)).toBe("ag-1");
    expect(q.status).toBe("active");
  });
});

describe("parseMetricList", () => {
  test("rejects non-numeric since", () => {
    const r = parseMetricList(url("since=tomorrow"), CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("accepts numeric since", () => {
    const r = parseMetricList(url("since=1700000000000"), CFG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sinceMs).toBe(1_700_000_000_000);
  });

  test("filters by name", () => {
    const r = parseMetricList(url("name=agent.token_count"), CFG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("agent.token_count");
  });
});

describe("parseTraceList", () => {
  test("captures since + agentId", () => {
    const r = parseTraceList(url("since=100&agentId=ag-1"), CFG);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sinceMs).toBe(100);
      expect(String(r.value.agentId)).toBe("ag-1");
    }
  });
});

describe("parseEventSubscription", () => {
  test("returns all topics when query absent", () => {
    const sub = parseEventSubscription(url(""));
    expect(sub.topics.length).toBe(4);
  });

  test("filters to requested topics", () => {
    const sub = parseEventSubscription(url("topics=agent-status,metric"));
    expect(sub.topics).toEqual(["agent-status", "metric"]);
  });

  test("ignores unknown topics", () => {
    const sub = parseEventSubscription(url("topics=agent-status,bogus"));
    expect(sub.topics).toEqual(["agent-status"]);
  });
});
