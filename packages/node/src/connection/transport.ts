/**
 * WebSocket transport — manages the connection to the Koi Gateway.
 *
 * Responsibilities:
 * - Establish and maintain a single multiplexed WS connection
 * - Queue outbound frames during disconnection
 * - Integrate heartbeat monitoring and reconnection
 * - Emit NodeEvents for connection lifecycle changes
 */

import type {
  AuthConfig,
  GatewayConnectionConfig,
  HeartbeatConfig,
  NodeEventListener,
  NodeFrame,
} from "../types.js";
import type { AuthHandshake } from "./auth.js";
import { createAuthHandshake } from "./auth.js";
import type { HeartbeatMonitor } from "./heartbeat.js";
import { createHeartbeatMonitor } from "./heartbeat.js";
import { decodeFrame, encodeFrame, generateCorrelationId } from "./protocol.js";
import {
  AUTH_FAILURE_CLOSE_CODE,
  calculateReconnectDelay,
  createReconnectState,
  isAuthFailure,
  isCleanClose,
  nextAttempt,
  resetReconnectState,
} from "./reconnect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface Transport {
  /** Current connection state. */
  readonly state: () => TransportState;
  /** Connect to the Gateway. */
  readonly connect: () => Promise<void>;
  /** Send a frame (queued if disconnected). */
  readonly send: (frame: NodeFrame) => void;
  /** Register a frame handler. Returns unsubscribe function. */
  readonly onFrame: (handler: (frame: NodeFrame) => void) => () => void;
  /** Register an event listener. Returns unsubscribe function. */
  readonly onEvent: (listener: NodeEventListener) => () => void;
  /** Gracefully close the connection. */
  readonly close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Maximum queued frames before oldest are evicted (backpressure). */
const MAX_QUEUE_SIZE = 10_000;

export function createTransport(
  nodeId: string,
  gatewayConfig: GatewayConnectionConfig,
  heartbeatConfig: HeartbeatConfig,
  authConfig?: AuthConfig | undefined,
): Transport {
  // let: WebSocket instance replaced on each reconnection attempt
  let ws: WebSocket | undefined;
  // let: mutable state machine for connection lifecycle
  let currentState: TransportState = "disconnected";
  // let: immutable record replaced via nextAttempt()/resetReconnectState()
  let reconnectState = createReconnectState();
  // let: timer handle cleared and reassigned on each reconnection schedule
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // let: heartbeat monitor replaced on each connection setup
  let heartbeat: HeartbeatMonitor | undefined;
  // let: auth handshake replaced on each connection when auth is configured
  let activeAuth: AuthHandshake | undefined;

  const frameHandlers = new Set<(frame: NodeFrame) => void>();
  const eventListeners = new Set<NodeEventListener>();
  // Bounded queue: oldest frames evicted when MAX_QUEUE_SIZE exceeded
  const outboundQueue: NodeFrame[] = [];

  // -- helpers --------------------------------------------------------------

  function emit(type: Parameters<NodeEventListener>[0]["type"], data?: unknown): void {
    const event = { type, timestamp: Date.now(), data };
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  function setState(next: TransportState): void {
    currentState = next;
  }

  function drainQueue(): void {
    if (outboundQueue.length === 0 || ws?.readyState !== WebSocket.OPEN) return;

    // Swap-and-iterate: O(n) total instead of O(n^2) from repeated shift()
    const pending = outboundQueue.splice(0);
    let i = 0;
    for (; i < pending.length; i++) {
      if (ws?.readyState !== WebSocket.OPEN) break;
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked by loop condition
      ws.send(encodeFrame(pending[i]!));
    }
    // Re-queue unsent frames at the front
    if (i < pending.length) {
      const remaining = pending.slice(i);
      // Prepend: copy existing elements forward, then fill front with remaining
      for (let j = outboundQueue.length - 1; j >= 0; j--) {
        const frame = outboundQueue[j];
        if (frame !== undefined) outboundQueue[j + remaining.length] = frame;
      }
      for (let j = 0; j < remaining.length; j++) {
        const frame = remaining[j];
        if (frame !== undefined) outboundQueue[j] = frame;
      }
    }
  }

  function scheduleReconnect(): void {
    if (currentState === "closed") return;

    reconnectState = nextAttempt(reconnectState, gatewayConfig.maxRetries);
    if (reconnectState.exhausted) {
      setState("disconnected");
      emit("reconnect_exhausted");
      return;
    }

    setState("reconnecting");
    emit("reconnecting", { attempt: reconnectState.attempt });

    const delay = calculateReconnectDelay(reconnectState.attempt, gatewayConfig);
    reconnectTimer = setTimeout(() => {
      void connectInternal();
    }, delay);
  }

  function setupHeartbeat(): void {
    heartbeat = createHeartbeatMonitor(heartbeatConfig, {
      onPing() {
        if (ws?.readyState === WebSocket.OPEN) {
          const pingFrame: NodeFrame = {
            nodeId,
            agentId: "",
            correlationId: generateCorrelationId(nodeId),
            type: "node:heartbeat",
            payload: { kind: "ping" },
          };
          ws.send(encodeFrame(pingFrame));
        }
      },
      onTimeout() {
        emit("heartbeat_timeout");
        ws?.close(4000, "Heartbeat timeout");
      },
    });
    heartbeat.start();
  }

  function finishConnect(): void {
    // Capture reconnect state before resetting — determines event type
    const isReconnect = reconnectState.attempt > 0;
    reconnectState = resetReconnectState();
    setupHeartbeat();
    drainQueue();

    emit(isReconnect ? "reconnected" : "connected");
  }

  async function connectInternal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      setState("connecting");

      try {
        // Close lingering WS from previous attempt to avoid double-callback
        if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "Reconnecting");
        }
        ws = new WebSocket(gatewayConfig.url);
      } catch (err: unknown) {
        setState("disconnected");
        reject(new Error("Failed to create WebSocket", { cause: err }));
        return;
      }

      ws.addEventListener("open", () => {
        if (authConfig !== undefined) {
          // Auth required — run handshake before transitioning to "connected"
          emit("auth_started");

          // Dispose previous auth handshake if any (from reconnect)
          if (activeAuth !== undefined) {
            activeAuth.dispose();
          }
          activeAuth = createAuthHandshake(nodeId, authConfig);

          activeAuth
            .start((frame) => {
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(encodeFrame(frame));
              }
            })
            .then(() => {
              activeAuth = undefined;
              emit("auth_success");
              setState("connected");
              finishConnect();
              resolve();
            })
            .catch((err: unknown) => {
              activeAuth = undefined;
              const reason = err instanceof Error ? err.message : String(err);
              emit("auth_failed", { reason });
              // Close with auth failure code — no reconnect (permanent rejection)
              ws?.close(AUTH_FAILURE_CLOSE_CODE, `Auth failed: ${reason}`);
              reject(new Error(`Auth failed: ${reason}`));
            });
        } else {
          // No auth — connect immediately (existing behavior)
          setState("connected");
          finishConnect();
          resolve();
        }
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const raw = event.data as string | ArrayBuffer;
        const result = decodeFrame(typeof raw === "string" ? raw : raw);
        if (!result.ok) return; // drop malformed frames

        const frame = result.value;

        // Route auth frames to active handshake
        if (activeAuth !== undefined) {
          if (frame.type === "node:auth_ack" || frame.type === "node:auth_challenge") {
            activeAuth.handleFrame(frame);
            return;
          }
        }

        // Handle heartbeat pong internally
        if (frame.type === "node:heartbeat") {
          const payload = frame.payload;
          if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
            // Safe: null/array excluded, typeof "object" confirmed
            const record = payload as Record<string, unknown>;
            if (record.kind === "pong") {
              heartbeat?.receivedPong();
              return;
            }
          }
        }

        for (const handler of frameHandlers) {
          handler(frame);
        }
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        heartbeat?.stop();
        heartbeat = undefined;
        // Dispose auth handshake on close to prevent timer leaks
        if (activeAuth !== undefined) {
          activeAuth.dispose();
          activeAuth = undefined;
        }
        emit("disconnected", { code: event.code, reason: event.reason });

        if (currentState === "closed") return;

        if (isCleanClose(event.code) || isAuthFailure(event.code)) {
          setState("disconnected");
        } else {
          scheduleReconnect();
        }
      });

      ws.addEventListener("error", () => {
        // Error events are followed by close events; reconnect handled there.
        // Reject only if this is the initial connect (not a reconnect).
        if (currentState === "connecting") {
          reject(new Error("WebSocket connection failed"));
        }
      });
    });
  }

  // -- public API -----------------------------------------------------------

  return {
    state() {
      return currentState;
    },

    async connect() {
      if (currentState === "connected" || currentState === "connecting") return;
      setState("disconnected");
      reconnectState = createReconnectState();
      await connectInternal();
    },

    send(frame: NodeFrame) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(frame));
      } else {
        // Evict oldest frames when queue is full (backpressure)
        if (outboundQueue.length >= MAX_QUEUE_SIZE) {
          outboundQueue.splice(0, outboundQueue.length - MAX_QUEUE_SIZE + 1);
        }
        outboundQueue.push(frame);
      }
    },

    onFrame(handler) {
      frameHandlers.add(handler);
      return () => {
        frameHandlers.delete(handler);
      };
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    async close() {
      setState("closed");
      heartbeat?.stop();
      heartbeat = undefined;

      if (activeAuth !== undefined) {
        activeAuth.dispose();
        activeAuth = undefined;
      }

      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }

      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Node shutting down");
      }
      ws = undefined;
      outboundQueue.splice(0);
    },
  };
}
