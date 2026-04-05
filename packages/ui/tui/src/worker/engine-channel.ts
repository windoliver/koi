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
 *   5. Updates connection status on ready / engine_done / engine_error
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
        // Flush any buffered engine_events synchronously before updating
        // connection status. Without this, the last text/tool deltas can be
        // overtaken by the disconnected status when they arrive in the same
        // message burst as engine_done.
        batcher.flushSync();
        store.dispatch({ kind: "set_connection_status", status: "disconnected" });
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

      // Interrupt the worker's current stream so it doesn't keep running
      // after the channel is torn down.
      worker.postMessage({ kind: "stream_interrupt" });

      // Post denial responses BEFORE setting disposed = true so the worker
      // is not left blocked waiting for approval_response. The .then() handlers
      // check !disposed and would suppress these if we set disposed first.
      for (const requestId of pendingApprovalIds) {
        worker.postMessage({
          kind: "approval_response",
          requestId,
          decision: { kind: "deny", reason: "channel disposed" },
        });
      }

      disposed = true; // now suppress any further message sends from .then() handlers

      // Clean up local bridge state (modal, timers) — the bridge's pending
      // Promises resolve with deny, but disposed = true above means the .then()
      // handlers will not double-post to the worker.
      cancelAllApprovals(); // also clears pendingApprovalIds

      batcher.dispose();
      worker.onmessage = null;
      worker.onerror = null;
    },
  };
}
