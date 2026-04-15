/**
 * EngineChannel — main-thread bridge between the engine worker and TUI store.
 *
 * Connects a Bun Worker (running the engine loop) to the TUI's reactive
 * state via the EventBatcher. The channel:
 *
 *   1. Receives WorkerToMainMessages via worker.onmessage
 *   2. Enqueues engine_event payloads into an EventBatcher (16ms cadence)
 *   3. On each batch flush: dispatches events to the store in order
 *   4. Forwards approval_request to the PermissionBridge and posts the
 *      resolved decision back as an approval_response
 *   5. Updates connection status on ready / engine_error / worker onerror
 *      (engine_done is a healthy end-of-turn signal and leaves the connection
 *      status untouched — the worker is still alive and ready for the next turn)
 *
 * The store's own queueMicrotask batching coalesces the N dispatches from
 * one flush into a single Solid re-render, keeping the UI at ≈60fps.
 */

import type { EngineEvent } from "@koi/core/engine";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@koi/core/worker-protocol";
import { createEventBatcher, type EventBatcherOptions } from "../batcher/event-batcher.js";
import type { PermissionBridge } from "../bridge/permission-bridge.js";
import type { TuiStore } from "../state/store.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimal worker surface required by EngineChannel (injectable in tests). */
export interface WorkerLike {
  postMessage(message: MainToWorkerMessage): void;
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface CreateEngineChannelConfig {
  /** TUI state store — receives dispatched engine events and status updates. */
  readonly store: TuiStore;
  /** Permission bridge — resolves HITL approval prompts from the worker. */
  readonly permissionBridge: PermissionBridge;
  /** EventBatcher tuning (injectable timer functions for tests). */
  readonly batcherOptions?: EventBatcherOptions;
}

export interface EngineChannelHandle {
  /** Send a typed message to the engine worker. */
  readonly send: (message: MainToWorkerMessage) => void;
  /**
   * Dispose the channel: cancel the batcher, drop pending events.
   * Does NOT terminate the worker — caller owns the worker lifecycle.
   */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEngineChannel(
  worker: WorkerLike,
  config: CreateEngineChannelConfig,
): EngineChannelHandle {
  const { store, permissionBridge, batcherOptions } = config;
  let disposed = false;
  // Tracks in-flight approval request IDs so dispose() can deny them, ensuring
  // the worker is never left blocked waiting for a response that will never come.
  const pendingApprovalIds = new Set<string>();

  // Cancel all in-flight approval flows on failure paths.
  //
  // Does NOT post denial directly to the worker — instead, permissionBridge.dispose()
  // resolves all outstanding bridge Promises with deny, which causes the channel's
  // .then() handlers to post the denial response. This prevents double-posting.
  //
  // After this call, pendingApprovalIds is cleared so the dispose() loop cannot
  // also post denials for the same requests.
  function cancelAllApprovals(): void {
    pendingApprovalIds.clear();
    // Dispose the bridge: clears the local modal and resolves pending Promises
    // with deny → .then() handlers post approval_response:deny to the worker.
    permissionBridge.dispose();
  }

  // Batch flush: dispatch all accumulated events to the store in order.
  // store.dispatch uses queueMicrotask internally, so all N dispatches
  // coalesce into one Solid re-render per flush window.
  const batcher = createEventBatcher<EngineEvent>((batch) => {
    if (disposed) return;
    for (const event of batch) {
      store.dispatch({ kind: "engine_event", event });
    }
  }, batcherOptions);

  worker.onmessage = (e: MessageEvent<WorkerToMainMessage>): void => {
    if (disposed) return;
    const msg = e.data;
    switch (msg.kind) {
      case "ready":
        store.dispatch({ kind: "set_connection_status", status: "connected" });
        break;

      case "engine_event":
        batcher.enqueue(msg.event);
        break;

      case "approval_request": {
        // Async: forward to permission bridge, then post the decision back.
        // The worker blocks its approval Promise until it receives the response.
        const { requestId, request } = msg;
        pendingApprovalIds.add(requestId);
        permissionBridge.handler(request).then(
          (decision) => {
            pendingApprovalIds.delete(requestId);
            if (!disposed) {
              worker.postMessage({ kind: "approval_response", requestId, decision });
            }
          },
          (err: unknown) => {
            // Bridge disposed or timed out — fail closed with a deny
            pendingApprovalIds.delete(requestId);
            if (!disposed) {
              worker.postMessage({
                kind: "approval_response",
                requestId,
                decision: {
                  kind: "deny",
                  reason: err instanceof Error ? err.message : "approval bridge error",
                },
              });
            }
          },
        );
        break;
      }

      case "engine_done":
        // Turn finished normally — the worker is still alive and ready for
        // the next turn, so connection status stays "connected". Flushing
        // the batcher here guarantees that buffered text/tool deltas from
        // the same burst are applied before any later action observes the
        // post-turn state. (#1753: /doctor previously reported
        // "disconnected" after a successful turn because this arm dispatched
        // set_connection_status:disconnected on every healthy end-of-turn.)
        batcher.flushSync();
        break;

      case "engine_error":
        batcher.flushSync();
        cancelAllApprovals();
        store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        store.dispatch({ kind: "add_error", code: "INTERNAL", message: msg.message });
        break;

      // No default needed — WorkerToMainMessage is a closed union; TypeScript
      // exhaustiveness is enforced at compile time via the switch arms above.
    }
  };

  worker.onerror = (e: ErrorEvent): void => {
    if (disposed) return;
    const message = e.message ?? "engine worker error";
    batcher.flushSync(); // preserve buffered content before error state
    cancelAllApprovals();
    store.dispatch({ kind: "set_connection_status", status: "disconnected" });
    store.dispatch({ kind: "add_error", code: "INTERNAL", message });
  };

  return {
    send(message: MainToWorkerMessage): void {
      if (!disposed) worker.postMessage(message);
    },

    dispose(): void {
      if (disposed) return;

      // #1753 review rounds 4 + 6 + 8: teardown must be
      // non-bypassable, resilient to per-message failures, AND
      // non-silent about dropped denials. A worker waiting on an
      // approval that the main side failed to deny would hang
      // indefinitely, so every failed denial is recorded and
      // surfaced to the operator via an add_error at the end of
      // dispose (the caller owns the Worker lifecycle and is the
      // only layer that can .terminate() it — we raise the alarm
      // loudly enough that they will).
      const strandedApprovalIds: string[] = [];
      try {
        // Interrupt the worker's current stream so it doesn't keep running
        // after the channel is torn down. Isolated so a throw here
        // cannot skip denial delivery for pending approvals below.
        let streamInterruptDelivered = true;
        try {
          worker.postMessage({ kind: "stream_interrupt" });
        } catch {
          streamInterruptDelivered = false;
          // worker is already unreachable — denial posts below will
          // also no-op, but we still run the loop so any still-live
          // request gets its response.
        }

        // Post denial responses BEFORE setting disposed = true so the worker
        // is not left blocked waiting for approval_response. The .then() handlers
        // check !disposed and would suppress these if we set disposed first.
        // Each denial is posted in isolation: one failing postMessage
        // must not strand the remaining pending requests, but any
        // drop is recorded for surface in the operator-visible error
        // below.
        for (const requestId of pendingApprovalIds) {
          try {
            worker.postMessage({
              kind: "approval_response",
              requestId,
              decision: { kind: "deny", reason: "channel disposed" },
            });
          } catch {
            strandedApprovalIds.push(requestId);
          }
        }

        // If even the stream_interrupt could not reach the worker,
        // assume every pending request is stranded so the operator
        // sees the full picture (the bridge side still resolves its
        // local promises via cancelAllApprovals below, but the
        // worker-facing side may be hung).
        if (!streamInterruptDelivered) {
          for (const requestId of pendingApprovalIds) {
            if (!strandedApprovalIds.includes(requestId)) {
              strandedApprovalIds.push(requestId);
            }
          }
        }
      } finally {
        // Even if worker.postMessage above threw, the remainder of
        // teardown MUST run so the channel is not half-closed.
        disposed = true; // now suppress any further message sends from .then() handlers

        // Clean up local bridge state (modal, timers) — the bridge's pending
        // Promises resolve with deny, but disposed = true above means the .then()
        // handlers will not double-post to the worker.
        try {
          cancelAllApprovals(); // also clears pendingApprovalIds
        } catch {
          // bridge dispose threw — continue, the channel is still
          // being torn down and we cannot leak handler references.
        }

        try {
          batcher.dispose();
        } catch {
          // batcher dispose is best-effort — the handler nulling
          // below guarantees no further events reach the store.
        }

        worker.onmessage = null;
        worker.onerror = null;

        // Transport teardown: after this point, send() is a no-op and
        // worker.onmessage/onerror are nulled, so no further traffic
        // can reach the store. Flip the UI connection status to
        // disconnected so /doctor cannot report a healthy engine for a
        // channel that has already been closed. Best-effort — store
        // dispatch failures must not block teardown.
        try {
          store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        } catch {
          // store unrecoverable — UI state may be stale, but the
          // transport is fully torn down so no more traffic can
          // confuse observers.
        }

        // #1753 review round 8: surface any stranded approval denials
        // so the operator (and/or the caller that owns the Worker) can
        // terminate the worker instead of letting it hang waiting on
        // an approval that will never arrive. Best-effort dispatch.
        if (strandedApprovalIds.length > 0) {
          try {
            store.dispatch({
              kind: "add_error",
              code: "INTERNAL",
              message: `engine channel dispose could not deliver approval_response for ${strandedApprovalIds.length} request(s) (${strandedApprovalIds.join(", ")}); worker may still be blocked and must be terminated by the host`,
            });
          } catch {
            // see above — transport is already down, nothing further
            // to do from here.
          }
        }
      }
    },
  };
}
