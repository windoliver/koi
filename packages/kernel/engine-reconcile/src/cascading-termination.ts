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
    void cascadeTerminate(registry, tree, event.agentId).catch((err: unknown) => {
      console.error(`[cascading-termination] cascade failed for agent "${event.agentId}"`, err);
    });
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

/**
 * Maximum retries on CAS conflict when transitioning a descendant to
 * "terminated". A conflict means another listener (health / supervision
 * reconciler, user-driven transition) bumped the generation between our
 * lookup and transition. Re-reading and retrying closes the race so a
 * cascaded kill isn't silently dropped.
 */
const MAX_CAS_RETRIES = 3;

async function cascadeTerminate(
  registry: AgentRegistry,
  tree: ProcessTree,
  terminatedAgentId: AgentId,
): Promise<void> {
  const queue: AgentId[] = [...tree.childrenOf(terminatedAgentId)];
  const visited = new Set<string>([terminatedAgentId]);
  let i = 0; // let justified: index pointer avoids O(n) shift per iteration

  while (i < queue.length) {
    // biome-ignore lint/style/noNonNullAssertion: i < queue.length guarantees element exists
    const childId = queue[i]!;
    i++;
    if (visited.has(childId)) continue;
    visited.add(childId);

    const terminated = await tryTerminateDescendant(registry, childId);
    if (terminated === "skip") continue;

    // Enqueue this child's children for further cascade — whether or not
    // we were the one who terminated it (status "already-terminated" means
    // someone else did, but its descendants still need the cascade).
    const grandchildren = tree.childrenOf(childId);
    for (const gc of grandchildren) {
      if (!visited.has(gc)) queue.push(gc);
    }
  }
}

/**
 * Attempt to transition a descendant to "terminated", retrying on CAS
 * conflict. Returns "skip" to drop the whole subtree from the cascade
 * (copilot, not-found, or unresolvable conflict); returns "cascade" to
 * continue descending into this node's children regardless of whether we
 * or someone else performed the terminal transition.
 */
async function tryTerminateDescendant(
  registry: AgentRegistry,
  childId: AgentId,
): Promise<"skip" | "cascade"> {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const entry = await registry.lookup(childId);

    // Not-found — deregistered underneath us. Nothing to cascade into.
    if (entry === undefined) return "skip";

    // Copilots survive parent death. Also skip their entire subtree.
    if (entry.agentType === "copilot") return "skip";

    // Already-terminated — don't transition, but still descend so the
    // cascade reaches grandchildren that may still be alive.
    if (entry.status.phase === "terminated") return "cascade";

    const result = await registry.transition(childId, "terminated", entry.status.generation, {
      kind: "evicted",
    });

    // Async registries return Result synchronously from this path; treat
    // success + generation-bump failures uniformly.
    if (result.ok) return "cascade";

    // Retry on CAS conflict — another listener bumped the generation.
    // Any other error code (NOT_FOUND, VALIDATION) is not resolvable by
    // retrying; treat as skip.
    if (result.error.code !== "CONFLICT") return "skip";
  }
  // Ran out of retries — log and stop the subtree to avoid pathological
  // looping under a genuine hot-spot race.
  console.warn(
    `[cascading-termination] CAS conflict unresolved for descendant "${childId}" after ${MAX_CAS_RETRIES} retries`,
  );
  return "skip";
}
