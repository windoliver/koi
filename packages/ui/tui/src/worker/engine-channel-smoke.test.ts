/**
 * EngineChannel smoke test — real Bun worker thread.
 *
 * Spawns a stub worker that emits a fixed sequence of messages and verifies
 * the full postMessage → EngineChannel → EventBatcher → store.dispatch chain
 * across an actual thread boundary.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@koi/core/worker-protocol";
import type { PermissionBridge } from "../bridge/permission-bridge.js";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import { createEngineChannel } from "./engine-channel.js";

const STUB_WORKER_PATH = join(import.meta.dir, "_stub-worker.ts");

/** Bridge stub — approvals not needed for this smoke test. */
const noopBridge: PermissionBridge = {
  handler: () => Promise.resolve({ kind: "allow" }),
  respond: () => {},
  dispose: () => {},
  pendingCount: () => 0,
};

test("real worker: receives 3 text deltas and engine_done via channel", async () => {
  const store = createStore(createInitialState());
  const worker = new Worker(STUB_WORKER_PATH) as unknown as {
    postMessage(msg: MainToWorkerMessage): void;
    onmessage: ((e: MessageEvent<WorkerToMainMessage>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
    terminate(): void;
  };

  const channel = createEngineChannel(worker, { store, permissionBridge: noopBridge });

  // Kick off the stub using WorkerEngineInput (clone-safe, no callHandlers/signal)
  channel.send({ kind: "stream_start", input: { kind: "text", text: "ping" } });

  // Allow all messages + microtasks + batcher flush to settle
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  const state = store.getState();
  expect(state.connectionStatus).toBe("disconnected"); // engine_done received

  const assistantMsg = state.messages.find((m) => m.kind === "assistant");
  expect(assistantMsg).toBeDefined();
  if (assistantMsg?.kind === "assistant") {
    const textBlock = assistantMsg.blocks.find((b) => b.kind === "text");
    expect(textBlock?.kind === "text" && textBlock.text).toBe("hello from worker");
  }

  channel.dispose();
  worker.terminate();
});
