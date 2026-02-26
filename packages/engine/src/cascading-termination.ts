/**
 * Cascading termination — automatically terminates descendant agents when
 * a parent transitions to "terminated".
 *
 * Watches the registry for terminated transitions, walks the process tree to
 * find all descendants, and CAS-transitions each to "terminated".
 * CAS conflicts are silently ignored (child already moved on).
 *
 * Supervision-aware: when a supervised child terminates, cascading to its
 * descendants is deferred to the supervision reconciler (which may restart
 * the child). When a supervisor itself terminates, cascading proceeds as
 * normal (all descendants are evicted).
 */

import type { AgentId, AgentRegistry } from "@koi/core";
import { isPromise } from "./is-promise.js";
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

    const descendants = tree.descendantsOf(event.agentId);
    for (const childId of descendants) {
      const entry = registry.lookup(childId);

      // Handle async registries gracefully via fire-and-forget
      if (isPromise(entry)) {
        void entry.then((resolved) => {
          if (resolved === undefined || resolved.status.phase === "terminated") return;
          const result = registry.transition(childId, "terminated", resolved.status.generation, {
            kind: "evicted",
          });
          void result;
        });
        continue;
      }

      if (entry === undefined || entry.status.phase === "terminated") continue;

      const result = registry.transition(childId, "terminated", entry.status.generation, {
        kind: "evicted",
      });

      // Handle async transition result (fire-and-forget, CAS conflict is expected)
      if (isPromise(result)) {
        void result;
      }
    }
  });

  return {
    async [Symbol.asyncDispose](): Promise<void> {
      unsubscribe();
    },
  };
}
