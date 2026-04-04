/// <reference lib="webworker" />
/**
 * Engine worker — runs the EngineAdapter loop in a Bun worker thread.
 *
 * The main thread owns the TUI render loop; this worker owns the engine:
 *   - Iterates adapter.stream(input) and posts every EngineEvent to main
 *   - Bridges approval requests bidirectionally (main resolves via TUI prompt)
 *   - Respects stream_interrupt via AbortController
 *   - Posts engine_done or engine_error when the stream ends
 *
 * Lifecycle:
 *   Main → Worker: stream_start { input }
 *   Worker → Main: ready                         ← worker initialised
 *   Worker → Main: engine_event { event }*       ← stream in progress
 *   Worker → Main: approval_request { ... }      ← HITL (optional)
 *   Main → Worker: approval_response { ... }     ← decision
 *   Worker → Main: engine_done | engine_error    ← stream ended
 *   Main → Worker: stream_interrupt              ← abort (any time)
 *   Main → Worker: shutdown                      ← terminate
 *
 * Wiring note (#1459):
 *   The engine adapter is created via `createAdapter()` below. Replace the
 *   stub with `createRuntime(config).adapter` once the CLI tui command is
 *   implemented. Pass runtime config via Bun.getEnvironmentData("config") or
 *   a serialisable init message posted before stream_start.
 */

import type { EngineAdapter, EngineInput } from "@koi/core/engine";
import type { ApprovalDecision, ApprovalRequest } from "@koi/core/middleware";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@koi/core/worker-protocol";

// ---------------------------------------------------------------------------
// Adapter bootstrap (replace stub with real runtime in #1459)
// ---------------------------------------------------------------------------

/**
 * Whether this worker has a real engine adapter configured.
 *
 * Set to `true` and replace `createAdapter()` once createRuntime() is wired
 * in #1459. While false, any stream_start is rejected immediately with
 * engine_error so the worker never silently enters a broken streaming state.
 */
const _IS_CONFIGURED = false;

/**
 * Create the engine adapter this worker will use.
 *
 * TODO (#1459): Replace with:
 *   import { createRuntime } from "@koi/runtime";
 *   const config = Bun.getEnvironmentData("engine-config") as RuntimeConfig;
 *   const { adapter } = await createRuntime(config);
 *   return adapter;
 */
async function createAdapter(): Promise<EngineAdapter> {
  throw new Error(
    "Engine worker: no adapter configured. " +
      "Wire a real EngineAdapter via createRuntime() in #1459.",
  );
}

// ---------------------------------------------------------------------------
// Approval bridge (worker side)
// ---------------------------------------------------------------------------

const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();

function requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  const requestId = crypto.randomUUID();
  return new Promise<ApprovalDecision>((resolve) => {
    pendingApprovals.set(requestId, (decision) => {
      pendingApprovals.delete(requestId);
      resolve(decision);
    });
    post({ kind: "approval_request", requestId, request });
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

// `let` justified: set once on stream_start, cleared on end/error/interrupt
let activeAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Startup — always post ready, always install a message handler
// ---------------------------------------------------------------------------

// Post ready unconditionally: the protocol requires it and callers wait for it.
// stream_start is rejected below when IS_CONFIGURED is false; shutdown is always
// handled so the worker can be terminated cleanly regardless of config state.
post({ kind: "ready" });

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>): Promise<void> => {
  const msg = e.data;

  switch (msg.kind) {
    case "stream_start": {
      if (activeAbortController !== null) {
        // Already streaming — reject the duplicate so the caller receives
        // an explicit terminal signal and does not wait forever.
        post({
          kind: "engine_error",
          message:
            "stream_start rejected: a stream is already active. " +
            "Send stream_interrupt first to stop the current run.",
        });
        return;
      }

      let adapter: EngineAdapter;
      try {
        adapter = await createAdapter();
      } catch (err: unknown) {
        post({
          kind: "engine_error",
          message: err instanceof Error ? err.message : "adapter initialisation failed",
        });
        return;
      }

      const controller = new AbortController();
      activeAbortController = controller;

      // Reconstruct the full EngineInput from the clone-safe WorkerEngineInput.
      // callHandlers are built locally by the worker's runtime (not sent over
      // postMessage — functions cannot be structured-cloned). The AbortSignal
      // comes from a fresh AbortController managed by this worker.
      const input: EngineInput = {
        ...msg.input,
        signal: controller.signal,
        // callHandlers will be added here once createAdapter() returns a runtime
        // with composed middleware. See TODO (#1459).
      };

      try {
        for await (const event of adapter.stream(input)) {
          if (controller.signal.aborted) break;
          post({ kind: "engine_event", event });
        }
        post({ kind: "engine_done" });
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          post({
            kind: "engine_error",
            message: err instanceof Error ? err.message : "stream error",
          });
        } else {
          // Interrupted by user — signal clean stop
          post({ kind: "engine_done" });
        }
      } finally {
        activeAbortController = null;
      }
      break;
    }

    case "stream_interrupt": {
      activeAbortController?.abort();
      break;
    }

    case "approval_response": {
      pendingApprovals.get(msg.requestId)?.(msg.decision);
      break;
    }

    case "shutdown": {
      activeAbortController?.abort();
      self.close();
      break;
    }

    // No default — MainToWorkerMessage is a closed union
  }
};

// Export requestApproval so tests or future wiring can access it
export { requestApproval };
