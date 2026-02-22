/**
 * Built-in eviction policies: LRU and QoS-aware.
 *
 * Policies are pure functions — no side effects, no mutation of input arrays.
 */

import type { EvictionCandidate, EvictionPolicy } from "@koi/core";

// ---------------------------------------------------------------------------
// LRU Policy — oldest heartbeat first
// ---------------------------------------------------------------------------

/** Evict agents with the oldest heartbeat first (Least Recently Used). */
export function lruPolicy(): EvictionPolicy {
  return {
    name: "lru",
    selectCandidates(
      candidates: readonly EvictionCandidate[],
      count: number,
    ): readonly EvictionCandidate[] {
      // Sort by lastHeartbeat ascending (oldest first), do not mutate input
      const sorted = [...candidates].sort((a, b) => a.lastHeartbeat - b.lastHeartbeat);
      return sorted.slice(0, count);
    },
  };
}

// ---------------------------------------------------------------------------
// QoS Policy — lowest priority first, then oldest heartbeat
// ---------------------------------------------------------------------------

/**
 * Evict agents with the lowest priority first. Break ties by oldest heartbeat.
 * Priority is a numeric value where lower = evicted first.
 */
export function qosPolicy(): EvictionPolicy {
  return {
    name: "qos",
    selectCandidates(
      candidates: readonly EvictionCandidate[],
      count: number,
    ): readonly EvictionCandidate[] {
      const sorted = [...candidates].sort((a, b) => {
        // Primary: lower priority evicted first
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Secondary: older heartbeat evicted first
        return a.lastHeartbeat - b.lastHeartbeat;
      });
      return sorted.slice(0, count);
    },
  };
}
