/**
 * Cascading termination — automatically terminates descendant agents when
 * a parent transitions to "terminated".
 *
 * Uses inline BFS with copilot subtree pruning: copilot children (and their
 * entire subtrees) are skipped during cascade because copilots survive
 * independently per the architecture doc.
 *
 * Supervision-aware: when a supervised child terminates, cascading to its
 * descendants is deferred to the supervision reconciler (which may restart
 * the child). When a supervisor itself terminates, cascading proceeds as
 * normal (all descendants are evicted).
 */

import type { AgentId, AgentRegistry } from "@koi/core";
import type { ProcessTree } from "./process-tree.js";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export interface CascadingTermination extends AsyncDisposable {}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param registry - Agent lifecycle registry.
 * @param tree - Process tree for ancestry queries.
 * @param isSupervised - Optional callback: returns true if the terminated agent
 *   is a supervised child whose parent should handle the failure. When true,
 *   cascading to descendants is skipped (the supervision reconciler handles it).
 *   When undefined, all terminations cascade unconditionally (existing behavior).
 */
export function createCascadingTermination(
  registry: AgentRegistry,
  tree: ProcessTree,
  isSupervised?: (agentId: AgentId) => boolean,
): CascadingTermination {
  const unsubscribe = registry.watch((event) => {
    if (event.kind !== "transitioned" || event.to !== "terminated") return;

    // If the terminated agent is a supervised child, defer to the supervision
    // reconciler — don't cascade to its descendants yet
    if (isSupervised?.(event.agentId)) {
      return;
    }

    // Inline BFS with copilot subtree pruning
    void cascadeTerminate(registry, tree, event.agentId);
  });

  return {
    async [Symbol.asyncDispose](): Promise<void> {
      unsubscribe();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal BFS cascade
// ---------------------------------------------------------------------------

async function cascadeTerminate(
  registry: AgentRegistry,
  tree: ProcessTree,
  terminatedAgentId: AgentId,
): Promise<void> {
  const queue: AgentId[] = [...tree.childrenOf(terminatedAgentId)];
  let i = 0; // let justified: index pointer avoids O(n) shift per iteration

  while (i < queue.length) {
    // biome-ignore lint/style/noNonNullAssertion: i < queue.length guarantees element exists
    const childId = queue[i]!;
    i++;

    const entry = await registry.lookup(childId);

    // Skip copilots — they survive parent death. Also skip their entire subtree.
    if (entry !== undefined && entry.agentType === "copilot") {
      continue;
    }

    // Skip already-terminated
    if (entry === undefined || entry.status.phase === "terminated") continue;

    // CAS-transition to terminated (conflict is expected, silently ignored)
    await registry.transition(childId, "terminated", entry.status.generation, {
      kind: "evicted",
    });

    // Enqueue this child's children for further cascade
    const grandchildren = tree.childrenOf(childId);
    for (const gc of grandchildren) {
      queue.push(gc);
    }
  }
}
