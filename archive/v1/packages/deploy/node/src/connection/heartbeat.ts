/**
 * Heartbeat monitor — detects dead WebSocket connections.
 *
 * Sends ping frames at a configurable interval, expects pong responses
 * within a timeout. Fires a callback when the connection appears dead.
 */

import type { HeartbeatConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatMonitor {
  /** Start the ping/pong cycle. */
  readonly start: () => void;
  /** Record that a pong was received. */
  readonly receivedPong: () => void;
  /** Stop monitoring (cleans up timers). */
  readonly stop: () => void;
  /** Whether the monitor is currently active. */
  readonly isActive: () => boolean;
}

export interface HeartbeatCallbacks {
  /** Called every interval — the caller should send a ping frame. */
  readonly onPing: () => void;
  /** Called when pong is not received within timeout. */
  readonly onTimeout: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHeartbeatMonitor(
  config: HeartbeatConfig,
  callbacks: HeartbeatCallbacks,
): HeartbeatMonitor {
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let awaitingPong = false;
  let active = false;

  function clearTimers(): void {
    if (pingTimer !== undefined) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
    if (pongTimer !== undefined) {
      clearTimeout(pongTimer);
      pongTimer = undefined;
    }
  }

  function schedulePongTimeout(): void {
    if (pongTimer !== undefined) {
      clearTimeout(pongTimer);
    }
    pongTimer = setTimeout(() => {
      if (awaitingPong && active) {
        callbacks.onTimeout();
      }
    }, config.timeout);
  }

  function sendPing(): void {
    if (!active) return;
    awaitingPong = true;
    schedulePongTimeout();
    callbacks.onPing();
  }

  return {
    start() {
      if (active) return;
      active = true;
      awaitingPong = false;
      pingTimer = setInterval(sendPing, config.interval);
    },

    receivedPong() {
      awaitingPong = false;
      if (pongTimer !== undefined) {
        clearTimeout(pongTimer);
        pongTimer = undefined;
      }
    },

    stop() {
      active = false;
      awaitingPong = false;
      clearTimers();
    },

    isActive() {
      return active;
    },
  };
}
