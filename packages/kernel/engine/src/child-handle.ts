/**
 * Child lifecycle handle — monitors a specific child agent's lifecycle
 * transitions and fires events for parent-side observation.
 *
 * Watches the registry for the specific child's transitions and maps them
 * to simplified ChildLifecycleEvent types. Supports signal/terminate for
 * parent-initiated control.
 *
 * Signal dispatch:
 *   stop  → transition to "suspended" at next turn boundary
 *   cont  → resume from "suspended" to "running"
 *   term  → abort current work, wait gracePeriodMs, then force-terminate
 *   usr1/usr2 → fire notify only, no state change
 *   other → notify + abort (backward-compat)
 */

import type {
  AgentId,
  AgentRegistry,
  ChildCompletionResult,
  ChildHandle,
  ChildLifecycleEvent,
  TransitionReason,
} from "@koi/core";
import { AGENT_SIGNALS, exitCodeForTransitionReason } from "@koi/core";

/** Default grace period for TERM signal before force-termination (ms). */
const DEFAULT_GRACE_PERIOD_MS = 5000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChildHandle(
  childId: AgentId,
  name: string,
  registry: AgentRegistry,
  abortController?: AbortController,
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
): ChildHandle {
  const listeners = new Set<(event: ChildLifecycleEvent) => void>();
  // let justified: set once, cleared on cleanup
  let unsubscribe: (() => void) | undefined;
  // let justified: last-seen TransitionReason for exit-code computation
  let lastReason: TransitionReason | undefined;

  function notify(event: ChildLifecycleEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  unsubscribe = registry.watch((event) => {
    if (event.kind === "transitioned" && event.agentId === childId) {
      // Capture the reason for exit-code computation
      lastReason = event.reason;

      // created → running = started
      if (event.from === "created" && event.to === "running") {
        notify({ kind: "started", childId });
      }

      // running → idle = idled
      if (event.from === "running" && event.to === "idle") {
        notify({ kind: "idled", childId });
      }

      // idle → running = woke
      if (event.from === "idle" && event.to === "running") {
        notify({ kind: "woke", childId });
      }

      // Any transition to terminated — map reason to completed/error/terminated
      if (event.to === "terminated") {
        const exitCode = exitCodeForTransitionReason(event.reason);
        if (event.reason.kind === "completed") {
          notify({ kind: "completed", childId, exitCode });
        } else if (event.reason.kind === "error") {
          notify({ kind: "error", childId, cause: event.reason.cause });
        }
        notify({ kind: "terminated", childId, exitCode });
        cleanup();
      }
    }

    // Deregistered = terminated (child removed from registry)
    if (event.kind === "deregistered" && event.agentId === childId) {
      // No reason available for deregister — use default exit code 1
      notify({ kind: "terminated", childId, exitCode: 1 });
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

    switch (kind) {
      case AGENT_SIGNALS.STOP: {
        const entry = await registry.lookup(childId);
        if (
          entry === undefined ||
          (entry.status.phase !== "running" && entry.status.phase !== "waiting")
        ) {
          return;
        }
        await registry.transition(childId, "suspended", entry.status.generation, {
          kind: "signal_stop",
        });
        break;
      }

      case AGENT_SIGNALS.CONT: {
        const entry = await registry.lookup(childId);
        if (entry === undefined || entry.status.phase !== "suspended") {
          return;
        }
        await registry.transition(childId, "running", entry.status.generation, {
          kind: "signal_cont",
        });
        break;
      }

      case AGENT_SIGNALS.TERM: {
        abortController?.abort(kind);
        // Wait for graceful shutdown then force-terminate
        await new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs));
        await terminate("signaled:term");
        break;
      }

      case AGENT_SIGNALS.USR1:
      case AGENT_SIGNALS.USR2:
        // Application-defined: notify only, no state change
        break;

      default:
        // Backward-compat: unknown signals abort the controller
        abortController?.abort(kind);
        break;
    }
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

  function waitForCompletion(): Promise<ChildCompletionResult> {
    return new Promise<ChildCompletionResult>((resolve) => {
      // If the child is already terminated (cleanup was already called),
      // we have no registry subscription — resolve immediately with exit code 1.
      if (unsubscribe === undefined) {
        resolve({
          childId,
          exitCode: 1,
          ...(lastReason !== undefined ? { reason: lastReason } : {}),
        });
        return;
      }

      // let justified: mutable ref to unsubscribe the per-completion listener
      let unsub: (() => void) | undefined;
      unsub = onEvent((event) => {
        if (event.kind === "terminated") {
          unsub?.();
          unsub = undefined;
          resolve({
            childId,
            exitCode: event.exitCode,
            ...(lastReason !== undefined ? { reason: lastReason } : {}),
          });
        }
      });
    });
  }

  function onEvent(listener: (event: ChildLifecycleEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    childId,
    name,
    onEvent,
    signal,
    terminate,
    waitForCompletion,
  };
}
