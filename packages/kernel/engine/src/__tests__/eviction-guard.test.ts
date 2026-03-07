import { describe, expect, test } from "bun:test";
import type { EvictionCandidate } from "@koi/core";
import { agentId } from "@koi/core";
import { lruPolicy, qosPolicy } from "@koi/engine-reconcile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidate(id: string, lastHeartbeat: number, priority = 100): EvictionCandidate {
  return {
    agentId: agentId(id),
    phase: "running",
    lastHeartbeat,
    priority,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// LRU Policy
// ---------------------------------------------------------------------------

describe("lruPolicy", () => {
  const policy = lruPolicy();

  test("selects oldest heartbeat first", () => {
    const candidates = [
      candidate("a1", 3000),
      candidate("a2", 1000), // oldest
      candidate("a3", 2000),
    ];

    const selected = policy.selectCandidates(candidates, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.agentId).toBe(agentId("a2"));
  });

  test("selects up to count candidates", () => {
    const candidates = [candidate("a1", 3000), candidate("a2", 1000), candidate("a3", 2000)];

    const selected = policy.selectCandidates(candidates, 2);
    expect(selected).toHaveLength(2);
    // Ordered: a2 (1000), a3 (2000)
    expect(selected[0]?.agentId).toBe(agentId("a2"));
    expect(selected[1]?.agentId).toBe(agentId("a3"));
  });

  test("returns all if count exceeds candidates", () => {
    const candidates = [candidate("a1", 1000)];
    const selected = policy.selectCandidates(candidates, 5);
    expect(selected).toHaveLength(1);
  });

  test("returns empty for empty candidates", () => {
    const selected = policy.selectCandidates([], 5);
    expect(selected).toHaveLength(0);
  });

  test("does not mutate input array", () => {
    const candidates = [candidate("a1", 3000), candidate("a2", 1000)];
    const copy = [...candidates];
    policy.selectCandidates(candidates, 1);
    expect(candidates).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// QoS Policy
// ---------------------------------------------------------------------------

describe("qosPolicy", () => {
  const policy = qosPolicy();

  test("selects lowest priority first", () => {
    const candidates = [
      candidate("premium", 1000, 300), // high priority
      candidate("spot", 1000, 50), // low priority — evict first
      candidate("standard", 1000, 100),
    ];

    const selected = policy.selectCandidates(candidates, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.agentId).toBe(agentId("spot"));
  });

  test("breaks ties by oldest heartbeat", () => {
    const candidates = [
      candidate("a1", 3000, 100), // same priority, newer
      candidate("a2", 1000, 100), // same priority, older — evict first
      candidate("a3", 2000, 100),
    ];

    const selected = policy.selectCandidates(candidates, 2);
    expect(selected[0]?.agentId).toBe(agentId("a2"));
    expect(selected[1]?.agentId).toBe(agentId("a3"));
  });

  test("priority takes precedence over heartbeat age", () => {
    const candidates = [
      candidate("premium-old", 1000, 300), // old but high priority
      candidate("spot-new", 3000, 50), // new but low priority
    ];

    const selected = policy.selectCandidates(candidates, 1);
    expect(selected[0]?.agentId).toBe(agentId("spot-new")); // low priority evicted first
  });

  test("name is qos", () => {
    expect(policy.name).toBe("qos");
  });
});
