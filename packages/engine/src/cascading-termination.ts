/**
 * Cascading termination — automatically terminates descendant agents when
 * a parent transitions to "terminated".
 *
 * Watches the registry for terminated transitions, walks the process tree to
 * find all descendants, and CAS-transitions each to "terminated".
 * CAS conflicts are silently ignored (child already moved on).
 *
 * Note: Assumes sync registry (InMemoryRegistry). Async registries would
 * need Promise handling for the transition calls.
 */

import type { AgentRegistry } from "@koi/core";
import type { ProcessTree } from "./process-tree.js";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export interface CascadingTermination extends AsyncDisposable {}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCascadingTermination(
  registry: AgentRegistry,
  tree: ProcessTree,
): CascadingTermination {
  const unsubscribe = registry.watch((event) => {
    if (event.kind !== "transitioned" || event.to !== "terminated") return;

    const descendants = tree.descendantsOf(event.agentId);
    for (const childId of descendants) {
      const entry = registry.lookup(childId);
      // lookup may return a promise for async registries, but we document
      // this assumes sync (InMemoryRegistry) where lookup returns directly
      if (entry === undefined || entry instanceof Promise) continue;

      const result = registry.transition(childId, "terminated", entry.status.generation, {
        kind: "evicted",
      });

      // CAS conflict is expected and silently ignored
      void result;
    }
  });

  return {
    async [Symbol.asyncDispose](): Promise<void> {
      unsubscribe();
    },
  };
}
