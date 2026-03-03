/**
 * SSE client — EventSource wrapper with auto-reconnect.
 *
 * Parses DashboardEventBatch messages and dispatches events
 * to a provided callback. Tracks connection state.
 */

import type { DashboardEventBatch } from "@koi/dashboard-types";

export type SseConnectionState = "connected" | "reconnecting" | "disconnected";

export interface SseClientOptions {
  readonly url: string;
  readonly onBatch: (batch: DashboardEventBatch) => void;
  readonly onStateChange: (state: SseConnectionState) => void;
  readonly reconnectDelayMs?: number;
}

export interface SseClient {
  readonly close: () => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function createSseClient(options: SseClientOptions): SseClient {
  const { url, onBatch, onStateChange, reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS } = options;

  let closed = false;
  // let justified: tracks reconnection backoff
  let currentDelay = reconnectDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let eventSource: EventSource | undefined;

  const connect = (): void => {
    if (closed) return;

    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      currentDelay = reconnectDelayMs;
      onStateChange("connected");
    };

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const batch = JSON.parse(event.data as string) as DashboardEventBatch;
        onBatch(batch);
      } catch {
        // Malformed SSE frame — skip
      }
    };

    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = undefined;

      if (closed) return;

      onStateChange("reconnecting");
      reconnectTimer = setTimeout(() => {
        currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY_MS);
        connect();
      }, currentDelay);
    };
  };

  connect();

  const close = (): void => {
    closed = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
    }
    eventSource?.close();
    eventSource = undefined;
    onStateChange("disconnected");
  };

  return { close };
}
