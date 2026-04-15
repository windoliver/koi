/**
 * EngineChannel unit tests — mock-based, no real worker spawned.
 *
 * Uses a MockWorker to inject WorkerToMainMessages directly, and injected
 * timer stubs (same DI pattern as EventBatcher tests) for deterministic
 * flush control.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ApprovalDecision } from "@koi/core/middleware";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@koi/core/worker-protocol";
import type { TimerHandle } from "../batcher/event-batcher.js";
import type { PermissionBridge } from "../bridge/permission-bridge.js";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import type { WorkerLike } from "./engine-channel.js";
import { createEngineChannel } from "./engine-channel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimerStub() {
  let pending: (() => void) | null = null;

  const schedule = mock((_fn: () => void, _ms: number): TimerHandle => {
    pending = _fn;
    return 0;
  });
  const cancel = mock((_id: TimerHandle): void => {
    pending = null;
  });

  return {
    schedule,
    cancel,
    tick(): void {
      if (pending) {
        const fn = pending;
        pending = null;
        fn();
      }
    },
  };
}

function makeWorker(): WorkerLike & {
  send(msg: WorkerToMainMessage): void;
  sent: MainToWorkerMessage[];
} {
  const sent: MainToWorkerMessage[] = [];
  const w: WorkerLike & { send(msg: WorkerToMainMessage): void; sent: MainToWorkerMessage[] } = {
    sent,
    onmessage: null,
    onerror: null,
    postMessage(msg: MainToWorkerMessage) {
      sent.push(msg);
    },
    send(msg: WorkerToMainMessage) {
      w.onmessage?.({ data: msg } as MessageEvent<WorkerToMainMessage>);
    },
  };
  return w;
}

function makePermissionBridge(decision: ApprovalDecision): PermissionBridge {
  return {
    handler: mock(() => Promise.resolve(decision)),
    respond: mock(() => {}),
    dispose: mock(() => {}),
    cancelPending: mock(() => {}),
    pendingCount: mock(() => 0),
  };
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

describe("EngineChannel — connection status", () => {
  test("ready message sets status to connected", async () => {
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
    });

    worker.send({ kind: "ready" });
    await Promise.resolve();

    expect(store.getState().connectionStatus).toBe("connected");
    channel.dispose();
  });

  test("engine_done leaves status connected (healthy end-of-turn, #1753)", async () => {
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
    });

    worker.send({ kind: "ready" });
    worker.send({ kind: "engine_done" });
    await Promise.resolve();

    // Regression: engine_done used to mark the channel "disconnected",
    // which caused /doctor to report a false-negative connection state
    // after every successful turn.
    expect(store.getState().connectionStatus).toBe("connected");
    channel.dispose();
  });

  test("engine_error sets disconnected and adds error block", async () => {
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
    });

    worker.send({ kind: "engine_error", message: "LLM unreachable" });
    await Promise.resolve();

    const state = store.getState();
    expect(state.connectionStatus).toBe("disconnected");
    const lastMsg = state.messages[state.messages.length - 1];
    expect(lastMsg?.kind).toBe("assistant");
    channel.dispose();
  });
});

// ---------------------------------------------------------------------------
// Event batching
// ---------------------------------------------------------------------------

describe("EngineChannel — event batching", () => {
  test("engine_event messages reach store after batcher flush", async () => {
    const timer = makeTimerStub();
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
      batcherOptions: { scheduleTimeout: timer.schedule, cancelTimeout: timer.cancel },
    });

    // Simulate a turn: turn_start → text_delta → turn_end → done
    worker.send({ kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } });
    worker.send({
      kind: "engine_event",
      event: { kind: "text_delta", delta: "hello world" },
    });

    // Events queued but not yet flushed
    expect(store.getState().messages).toHaveLength(0);

    await Promise.resolve(); // microtask → schedules timeout
    timer.tick(); // flush

    await Promise.resolve(); // store's queueMicrotask
    const state = store.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.kind).toBe("assistant");
    channel.dispose();
  });

  test("multiple engine_events in one tick arrive as one batch", async () => {
    const timer = makeTimerStub();
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
      batcherOptions: { scheduleTimeout: timer.schedule, cancelTimeout: timer.cancel },
    });

    // 3 text_deltas in one tick (turn_start first to open the message)
    worker.send({ kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } });
    worker.send({ kind: "engine_event", event: { kind: "text_delta", delta: "a" } });
    worker.send({ kind: "engine_event", event: { kind: "text_delta", delta: "b" } });
    worker.send({ kind: "engine_event", event: { kind: "text_delta", delta: "c" } });

    await Promise.resolve();
    timer.tick();
    await Promise.resolve();

    const msg = store.getState().messages[0];
    expect(msg?.kind).toBe("assistant");
    if (msg?.kind === "assistant") {
      const textBlock = msg.blocks.find((b) => b.kind === "text");
      expect(textBlock?.kind === "text" && textBlock.text).toBe("abc");
    }
    channel.dispose();
  });

  test("engine_done flushes buffered events and preserves connected status", async () => {
    const timer = makeTimerStub();
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
      batcherOptions: { scheduleTimeout: timer.schedule, cancelTimeout: timer.cancel },
    });

    // Simulate a healthy turn: ready → buffered events → engine_done arrives
    // before the batcher timer fires.
    worker.send({ kind: "ready" });
    worker.send({ kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } });
    worker.send({ kind: "engine_event", event: { kind: "text_delta", delta: "last" } });
    worker.send({ kind: "engine_done" });

    // engine_done must have flushed the batcher synchronously.
    await Promise.resolve();
    const state = store.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.kind).toBe("assistant");
    // #1753: engine_done is a healthy end-of-turn signal — the channel
    // remains "connected" so /doctor reports accurate status.
    expect(state.connectionStatus).toBe("connected");
    channel.dispose();
  });
});

// ---------------------------------------------------------------------------
// Approval handling
// ---------------------------------------------------------------------------

describe("EngineChannel — approvals", () => {
  test("approval_request triggers bridge handler and posts response back", async () => {
    const decision: ApprovalDecision = { kind: "allow" };
    const bridge = makePermissionBridge(decision);
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, { store, permissionBridge: bridge });

    worker.send({
      kind: "approval_request",
      requestId: "req-1",
      request: {
        toolId: "bash",
        input: { cmd: "ls" },
        reason: "list files",
      },
    });

    // Let the promise resolve
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.handler).toHaveBeenCalledTimes(1);
    const response = worker.sent.find((m) => m.kind === "approval_response");
    expect(response).toMatchObject({ kind: "approval_response", requestId: "req-1", decision });
    channel.dispose();
  });

  test("engine_error cancels in-flight approval: bridge disposed and denial posted to worker", async () => {
    let resolveBridgePromise: ((d: ApprovalDecision) => void) | undefined;
    const pendingHandler = mock(
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          resolveBridgePromise = resolve;
        }),
    );
    // Bridge mock with a dispose() that resolves the pending promise with deny
    // (simulating the real bridge's dispose behaviour)
    const disposeMock = mock(() => {
      resolveBridgePromise?.({ kind: "deny", reason: "bridge disposed" });
    });
    const bridge: PermissionBridge = {
      handler: pendingHandler,
      respond: mock(() => {}),
      dispose: disposeMock,
      cancelPending: mock(() => {}),
      pendingCount: mock(() => 0),
    };

    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, { store, permissionBridge: bridge });

    // Send approval_request (sets up in-flight promise)
    worker.send({
      kind: "approval_request",
      requestId: "req-x",
      request: { toolId: "bash", input: {}, reason: "test" },
    });
    await Promise.resolve(); // let bridge.handler get called

    expect(pendingHandler).toHaveBeenCalledTimes(1);
    expect(worker.sent).toHaveLength(0); // bridge promise not yet resolved

    // Worker dies with an error
    worker.send({ kind: "engine_error", message: "crashed" });

    // engine_error should have disposed the bridge (clearing the local modal)
    expect(disposeMock).toHaveBeenCalledTimes(1);

    // The bridge dispose resolves pending Promises with deny, so the .then()
    // handler will eventually post approval_response:deny to the worker.
    await Promise.resolve();
    await Promise.resolve();
    const deny = worker.sent.find((m) => m.kind === "approval_response");
    expect(deny).toBeDefined();
    if (deny?.kind === "approval_response") {
      expect(deny.requestId).toBe("req-x");
      expect(deny.decision.kind).toBe("deny");
    }

    channel.dispose();
  });

  test("approval_request denied when bridge rejects", async () => {
    const bridge: PermissionBridge = {
      handler: mock(() => Promise.reject(new Error("bridge disposed"))),
      respond: mock(() => {}),
      dispose: mock(() => {}),
      cancelPending: mock(() => {}),
      pendingCount: mock(() => 0),
    };
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, { store, permissionBridge: bridge });

    worker.send({
      kind: "approval_request",
      requestId: "req-2",
      request: { toolId: "bash", input: {}, reason: "test" },
    });

    await Promise.resolve();
    await Promise.resolve();

    const response = worker.sent.find((m) => m.kind === "approval_response");
    expect(response?.kind).toBe("approval_response");
    if (response?.kind === "approval_response") {
      expect(response.decision.kind).toBe("deny");
    }
    channel.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose() behaviour
// ---------------------------------------------------------------------------

describe("EngineChannel — dispose", () => {
  test("dispose() prevents further store dispatches", async () => {
    const timer = makeTimerStub();
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
      batcherOptions: { scheduleTimeout: timer.schedule, cancelTimeout: timer.cancel },
    });

    worker.send({ kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } });
    await Promise.resolve(); // microtask schedules timer

    channel.dispose();
    timer.tick(); // flush fires but batcher is disposed

    await Promise.resolve();
    expect(store.getState().messages).toHaveLength(0);
  });

  test("dispose() calls permissionBridge.dispose() to clear local modal state", () => {
    const bridge = makePermissionBridge({ kind: "allow" });
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, { store, permissionBridge: bridge });

    channel.dispose();

    expect(bridge.dispose).toHaveBeenCalledTimes(1);
  });

  test("dispose() removes worker message handlers", () => {
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
    });

    channel.dispose();

    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
  });

  test("send() after dispose() is a no-op — no extra messages beyond dispose()'s own", () => {
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
    });

    channel.dispose();
    const countAfterDispose = worker.sent.length; // dispose() sends stream_interrupt

    // Calling send() after dispose() must not add any further messages
    channel.send({ kind: "shutdown" });
    expect(worker.sent).toHaveLength(countAfterDispose);
  });
});

// ---------------------------------------------------------------------------
// onerror handler
// ---------------------------------------------------------------------------

describe("EngineChannel — worker onerror", () => {
  test("worker error event sets disconnected and adds error", async () => {
    const store = createStore(createInitialState());
    const worker = makeWorker();
    const channel = createEngineChannel(worker, {
      store,
      permissionBridge: makePermissionBridge({ kind: "allow" }),
    });

    worker.onerror?.({ message: "Worker crashed" } as ErrorEvent);
    await Promise.resolve();

    const state = store.getState();
    expect(state.connectionStatus).toBe("disconnected");
    const lastMsg = state.messages[state.messages.length - 1];
    expect(lastMsg?.kind).toBe("assistant");
    channel.dispose();
  });
});
