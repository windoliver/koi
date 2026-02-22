/**
 * Mock Transport for unit-testing modules that depend on Transport
 * without a real WebSocket connection.
 *
 * Captures sent frames, allows injecting received frames, and
 * simulates connection lifecycle events.
 */

import type { Transport, TransportState } from "../../src/connection/transport.js";
import type { NodeEventListener, NodeFrame } from "../../src/types.js";

export interface MockTransport extends Transport {
  /** All frames sent via transport.send(). */
  readonly sentFrames: readonly NodeFrame[];
  /** Inject a frame as if received from the Gateway. */
  readonly injectFrame: (frame: NodeFrame) => void;
  /** Simulate a transport event (connected, disconnected, etc.). */
  readonly injectEvent: (type: Parameters<NodeEventListener>[0]["type"], data?: unknown) => void;
  /** Set the current state (for testing state-dependent code paths). */
  readonly setState: (state: TransportState) => void;
}

export function createMockTransport(): MockTransport {
  let currentState: TransportState = "disconnected";
  const sentFrames: NodeFrame[] = [];
  const frameHandlers = new Set<(frame: NodeFrame) => void>();
  const eventListeners = new Set<NodeEventListener>();

  return {
    sentFrames,

    state() {
      return currentState;
    },

    async connect() {
      currentState = "connected";
      const event = { type: "connected" as const, timestamp: Date.now() };
      for (const listener of eventListeners) {
        listener(event);
      }
    },

    send(frame) {
      sentFrames.push(frame);
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
      currentState = "closed";
    },

    injectFrame(frame) {
      for (const handler of frameHandlers) {
        handler(frame);
      }
    },

    injectEvent(type, data) {
      const event = { type, timestamp: Date.now(), data };
      for (const listener of eventListeners) {
        listener(event);
      }
    },

    setState(state) {
      currentState = state;
    },
  };
}
