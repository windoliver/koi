/**
 * Child lifecycle handle — monitors a specific child agent's lifecycle
 * transitions and fires events for parent-side observation.
 *
 * Watches the registry for the specific child's transitions and maps them
 * to simplified ChildLifecycleEvent types. Supports signal/terminate for
 * parent-initiated control.
 */

import type { AgentId, AgentRegistry, ChildHandle, ChildLifecycleEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChildHandle(
  childId: AgentId,
  name: string,
  registry: AgentRegistry,
  abortController?: AbortController,
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

      // Any transition to terminated — map reason to completed/error/terminated
      if (event.to === "terminated") {
        if (event.reason.kind === "completed") {
          notify({ kind: "completed", childId });
        } else if (event.reason.kind === "error") {
          notify({ kind: "error", childId, cause: event.reason.cause });
        }
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

  async function signal(kind: string): Promise<void> {
    notify({ kind: "signaled", childId, signal: kind });
    abortController?.abort(kind);
  }

  async function terminate(_reason?: string): Promise<void> {
    const entry = await registry.lookup(childId);
    if (entry === undefined || entry.status.phase === "terminated") return;

    const result = await registry.transition(childId, "terminated", entry.status.generation, {
      kind: "evicted",
    });

    // Retry once on CAS conflict (entry may have moved between lookup and transition)
    if (!result.ok && result.error.code === "CONFLICT") {
      const retryEntry = await registry.lookup(childId);
      if (retryEntry === undefined || retryEntry.status.phase === "terminated") return;
      await registry.transition(childId, "terminated", retryEntry.status.generation, {
        kind: "evicted",
      });
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
    signal,
    terminate,
  };
}
