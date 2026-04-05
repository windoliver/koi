/**
 * Stub engine worker for smoke testing the EngineChannel across a real Bun
 * worker thread boundary. Not shipped — used only by engine-channel-smoke.test.ts.
 *
 * Behaviour: posts ready on startup; on stream_start, emits 3 text_delta events
 * then engine_done. Matches the documented worker-protocol handshake.
 */
/// <reference lib="webworker" />
import type { MainToWorkerMessage, WorkerToMainMessage } from "@koi/core/worker-protocol";

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

// Post ready immediately on startup — per protocol, main thread waits for this
// before sending stream_start.
post({ kind: "ready" });

self.onmessage = (e: MessageEvent<MainToWorkerMessage>): void => {
  // stream_start carries WorkerEngineInput (clone-safe subset of EngineInput)
  if (e.data.kind === "stream_start") {
    post({ kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } });
    post({ kind: "engine_event", event: { kind: "text_delta", delta: "hello " } });
    post({ kind: "engine_event", event: { kind: "text_delta", delta: "from " } });
    post({ kind: "engine_event", event: { kind: "text_delta", delta: "worker" } });
    post({ kind: "engine_event", event: { kind: "turn_end", turnIndex: 0 } });
    post({ kind: "engine_done" });
  }
};
