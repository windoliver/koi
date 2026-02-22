/**
 * Child lifecycle handle — monitors a specific child agent's lifecycle
 * transitions and fires events for parent-side observation.
 *
 * Watches the registry for the specific child's transitions and maps them
 * to simplified ChildLifecycleEvent types.
 */

import type { AgentId, AgentRegistry, ChildHandle, ChildLifecycleEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChildHandle(
  childId: AgentId,
  name: string,
  registry: AgentRegistry,
): ChildHandle {
  const listeners = new Set<(event: ChildLifecycleEvent) => void>();
  let unsubscribe: (() => void) | undefined; // let justified: set once, cleared on cleanup

  function notify(event: ChildLifecycleEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  unsubscribe = registry.watch((event) => {
    if (event.kind === "transitioned" && event.agentId === childId) {
      // created → running = started
      if (event.from === "created" && event.to === "running") {
        notify({ kind: "started", childId });
      }

      // Any transition to terminated
      if (event.to === "terminated") {
        notify({ kind: "terminated", childId });
        cleanup();
      }
    }

    // Deregistered = terminated (child removed from registry)
    if (event.kind === "deregistered" && event.agentId === childId) {
      notify({ kind: "terminated", childId });
      cleanup();
    }
  });

  function cleanup(): void {
    if (unsubscribe !== undefined) {
      unsubscribe();
      unsubscribe = undefined;
    }
  }

  return {
    childId,
    name,
    onEvent: (listener: (event: ChildLifecycleEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
