import { describe, expect, test } from "bun:test";
import type { AgentId, EvictionCandidate } from "@koi/core";
import { agentId } from "@koi/core";
import { lruPolicy, qosPolicy } from "./eviction-policies.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function candidate(
  overrides: Partial<EvictionCandidate> & { readonly agentId: AgentId },
): EvictionCandidate {
  return {
    phase: "running",
    lastHeartbeat: Date.now(),
    priority: 0,
    metadata: {},
    ...overrides,
  };
}

function id(name: string): AgentId {
  return agentId(name);
}

// ---------------------------------------------------------------------------
// LRU Policy
// ---------------------------------------------------------------------------

describe("lruPolicy", () => {
  const policy = lruPolicy();

  test("has correct name", () => {
    expect(policy.name).toBe("lru");
  });

  test("returns empty array for empty candidates", () => {
    const result = policy.selectCandidates([], 5);
    expect(result).toEqual([]);
  });

  test("returns empty array when count is 0", () => {
    const candidates = [candidate({ agentId: id("a"), lastHeartbeat: 100 })];
    const result = policy.selectCandidates(candidates, 0);
    expect(result).toEqual([]);
  });

  test("selects the oldest heartbeat first", () => {
    const candidates = [
      candidate({ agentId: id("new"), lastHeartbeat: 300 }),
      candidate({ agentId: id("old"), lastHeartbeat: 100 }),
      candidate({ agentId: id("mid"), lastHeartbeat: 200 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe(id("old"));
  });

  test("selects multiple ordered by oldest heartbeat", () => {
    const candidates = [
      candidate({ agentId: id("c"), lastHeartbeat: 300 }),
      candidate({ agentId: id("a"), lastHeartbeat: 100 }),
      candidate({ agentId: id("b"), lastHeartbeat: 200 }),
    ];
    const result = policy.selectCandidates(candidates, 2);
    expect(result).toHaveLength(2);
    expect(result[0]?.agentId).toBe(id("a"));
    expect(result[1]?.agentId).toBe(id("b"));
  });

  test("returns all candidates when count exceeds length", () => {
    const candidates = [
      candidate({ agentId: id("a"), lastHeartbeat: 100 }),
      candidate({ agentId: id("b"), lastHeartbeat: 200 }),
    ];
    const result = policy.selectCandidates(candidates, 10);
    expect(result).toHaveLength(2);
    expect(result[0]?.agentId).toBe(id("a"));
    expect(result[1]?.agentId).toBe(id("b"));
  });

  test("returns all candidates when count equals length", () => {
    const candidates = [
      candidate({ agentId: id("b"), lastHeartbeat: 200 }),
      candidate({ agentId: id("a"), lastHeartbeat: 100 }),
    ];
    const result = policy.selectCandidates(candidates, 2);
    expect(result).toHaveLength(2);
    expect(result[0]?.agentId).toBe(id("a"));
  });

  test("handles single candidate", () => {
    const candidates = [candidate({ agentId: id("only"), lastHeartbeat: 42 })];
    const result = policy.selectCandidates(candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe(id("only"));
  });

  test("handles identical heartbeats (stable order)", () => {
    const ts = Date.now();
    const candidates = [
      candidate({ agentId: id("a"), lastHeartbeat: ts }),
      candidate({ agentId: id("b"), lastHeartbeat: ts }),
      candidate({ agentId: id("c"), lastHeartbeat: ts }),
    ];
    const result = policy.selectCandidates(candidates, 2);
    expect(result).toHaveLength(2);
  });

  test("does not mutate input array", () => {
    const candidates = [
      candidate({ agentId: id("b"), lastHeartbeat: 200 }),
      candidate({ agentId: id("a"), lastHeartbeat: 100 }),
    ];
    const originalFirst = candidates[0]?.agentId;
    policy.selectCandidates(candidates, 1);
    expect(candidates[0]?.agentId).toBe(originalFirst);
  });

  test("ignores priority (LRU uses heartbeat only)", () => {
    const candidates = [
      candidate({ agentId: id("high-prio"), lastHeartbeat: 100, priority: 100 }),
      candidate({ agentId: id("low-prio"), lastHeartbeat: 200, priority: 1 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    // LRU should pick oldest heartbeat regardless of priority
    expect(result[0]?.agentId).toBe(id("high-prio"));
  });

  test("handles large candidate sets", () => {
    const candidates = Array.from({ length: 1000 }, (_, i) =>
      candidate({ agentId: id(`agent-${i}`), lastHeartbeat: 1000 - i }),
    );
    const result = policy.selectCandidates(candidates, 10);
    expect(result).toHaveLength(10);
    // Oldest heartbeat = agent-999 (heartbeat 1)
    expect(result[0]?.agentId).toBe(id("agent-999"));
  });
});

// ---------------------------------------------------------------------------
// QoS Policy
// ---------------------------------------------------------------------------

describe("qosPolicy", () => {
  const policy = qosPolicy();

  test("has correct name", () => {
    expect(policy.name).toBe("qos");
  });

  test("returns empty array for empty candidates", () => {
    const result = policy.selectCandidates([], 5);
    expect(result).toEqual([]);
  });

  test("returns empty array when count is 0", () => {
    const candidates = [candidate({ agentId: id("a"), priority: 1 })];
    const result = policy.selectCandidates(candidates, 0);
    expect(result).toEqual([]);
  });

  test("selects lowest priority first", () => {
    const candidates = [
      candidate({ agentId: id("high"), priority: 100, lastHeartbeat: 100 }),
      candidate({ agentId: id("low"), priority: 1, lastHeartbeat: 100 }),
      candidate({ agentId: id("mid"), priority: 50, lastHeartbeat: 100 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe(id("low"));
  });

  test("breaks priority ties by oldest heartbeat", () => {
    const candidates = [
      candidate({ agentId: id("newer"), priority: 5, lastHeartbeat: 300 }),
      candidate({ agentId: id("older"), priority: 5, lastHeartbeat: 100 }),
      candidate({ agentId: id("middle"), priority: 5, lastHeartbeat: 200 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe(id("older"));
  });

  test("selects multiple ordered by priority then heartbeat", () => {
    const candidates = [
      candidate({ agentId: id("high-new"), priority: 100, lastHeartbeat: 300 }),
      candidate({ agentId: id("low-old"), priority: 1, lastHeartbeat: 100 }),
      candidate({ agentId: id("low-new"), priority: 1, lastHeartbeat: 200 }),
      candidate({ agentId: id("mid-old"), priority: 50, lastHeartbeat: 50 }),
    ];
    const result = policy.selectCandidates(candidates, 3);
    expect(result).toHaveLength(3);
    // lowest priority (1) sorted by heartbeat, then mid (50)
    expect(result[0]?.agentId).toBe(id("low-old"));
    expect(result[1]?.agentId).toBe(id("low-new"));
    expect(result[2]?.agentId).toBe(id("mid-old"));
  });

  test("returns all candidates when count exceeds length", () => {
    const candidates = [
      candidate({ agentId: id("a"), priority: 2 }),
      candidate({ agentId: id("b"), priority: 1 }),
    ];
    const result = policy.selectCandidates(candidates, 10);
    expect(result).toHaveLength(2);
    expect(result[0]?.agentId).toBe(id("b"));
  });

  test("handles single candidate", () => {
    const candidates = [candidate({ agentId: id("only"), priority: 42 })];
    const result = policy.selectCandidates(candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe(id("only"));
  });

  test("does not mutate input array", () => {
    const candidates = [
      candidate({ agentId: id("b"), priority: 1 }),
      candidate({ agentId: id("a"), priority: 2 }),
    ];
    const originalFirst = candidates[0]?.agentId;
    policy.selectCandidates(candidates, 1);
    expect(candidates[0]?.agentId).toBe(originalFirst);
  });

  test("handles zero priority", () => {
    const candidates = [
      candidate({ agentId: id("positive"), priority: 1, lastHeartbeat: 100 }),
      candidate({ agentId: id("zero"), priority: 0, lastHeartbeat: 100 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    expect(result[0]?.agentId).toBe(id("zero"));
  });

  test("handles negative priority", () => {
    const candidates = [
      candidate({ agentId: id("positive"), priority: 1, lastHeartbeat: 100 }),
      candidate({ agentId: id("negative"), priority: -1, lastHeartbeat: 100 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    expect(result[0]?.agentId).toBe(id("negative"));
  });

  test("priority takes precedence over heartbeat", () => {
    // Agent with oldest heartbeat but highest priority should NOT be evicted first
    const candidates = [
      candidate({ agentId: id("old-high"), priority: 100, lastHeartbeat: 1 }),
      candidate({ agentId: id("new-low"), priority: 1, lastHeartbeat: 999 }),
    ];
    const result = policy.selectCandidates(candidates, 1);
    expect(result[0]?.agentId).toBe(id("new-low"));
  });

  test("handles large candidate sets with mixed priorities", () => {
    const candidates = Array.from({ length: 1000 }, (_, i) =>
      candidate({
        agentId: id(`agent-${i}`),
        priority: i % 3, // 0, 1, 2, 0, 1, 2, ...
        lastHeartbeat: 1000 - i,
      }),
    );
    const result = policy.selectCandidates(candidates, 5);
    expect(result).toHaveLength(5);
    // All selected should have priority 0
    for (const r of result) {
      expect(r.priority).toBe(0);
    }
  });
});
