/**
 * Shared process accounter — tracks active process count from registry events.
 *
 * Watches the AgentRegistry for registration, deregistration, and terminal-state
 * transitions to maintain an accurate count of active processes across the swarm.
 */

import type { AgentRegistry, ProcessAccounter } from "@koi/core";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export interface SharedProcessAccounter extends ProcessAccounter, AsyncDisposable {}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProcessAccounter(registry: AgentRegistry): SharedProcessAccounter {
  let count = 0; // let justified: mutable counter tracking active processes
  /** Tracks agents already decremented via terminated transition to prevent double-decrement. */
  const decremented = new Set<string>();

  const unsubscribe = registry.watch((event) => {
    if (event.kind === "registered") {
      count++;
      decremented.delete(event.entry.agentId);
    }

    if (event.kind === "deregistered") {
      if (!decremented.has(event.agentId)) {
        count = Math.max(0, count - 1);
      }
      decremented.delete(event.agentId);
    }

    if (event.kind === "transitioned" && event.to === "terminated") {
      count = Math.max(0, count - 1);
      decremented.add(event.agentId);
    }
  });

  return {
    activeCount: () => count,
    increment: () => {
      count++;
    },
    decrement: () => {
      count = Math.max(0, count - 1);
    },
    async [Symbol.asyncDispose](): Promise<void> {
      unsubscribe();
      count = 0;
    },
  };
}
