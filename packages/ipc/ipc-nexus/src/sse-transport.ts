/**
 * SSE connection manager — connects, reconnects, delivers notifications.
 *
 * Uses native `fetch()` with streaming response body — zero new deps.
 * Reconnects with exponential backoff and sends `Last-Event-ID` header.
 * Keepalive timeout detects dead connections (no data for 45s → reconnect).
 */

import {
  DEFAULT_SSE_KEEPALIVE_TIMEOUT_MS,
  DEFAULT_SSE_RECONNECT_MAX_MS,
  DEFAULT_SSE_RECONNECT_MIN_MS,
} from "./constants.js";
import { parseSseStream } from "./sse-stream.js";

// ---------------------------------------------------------------------------
// Config & types
// ---------------------------------------------------------------------------

/** Minimal fetch signature for dependency injection (testability). */
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SseTransportConfig {
  readonly url: string;
  readonly agentId: string;
  readonly authToken?: string | undefined;
  readonly reconnectMinMs?: number | undefined;
  readonly reconnectMaxMs?: number | undefined;
  readonly keepaliveTimeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Custom fetch implementation — defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchFn | undefined;
}

export interface SseTransport {
  /** Register a notification handler. Returns unsubscribe function. */
  readonly onNotification: (handler: () => void) => () => void;
  /** Start the SSE connection loop. */
  readonly start: () => void;
  /** Stop the SSE connection and prevent reconnection. */
  readonly stop: () => void;
  /** Whether the transport is currently connected to the SSE stream. */
  readonly connected: () => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSseTransport(config: SseTransportConfig): SseTransport {
  const {
    url,
    agentId,
    authToken,
    reconnectMinMs = DEFAULT_SSE_RECONNECT_MIN_MS,
    reconnectMaxMs = DEFAULT_SSE_RECONNECT_MAX_MS,
    keepaliveTimeoutMs = DEFAULT_SSE_KEEPALIVE_TIMEOUT_MS,
    signal: externalSignal,
    fetchImpl = globalThis.fetch,
  } = config;

  const handlers = new Set<() => void>();

  // let justified: mutable connection state
  let abortController: AbortController | undefined;
  let isConnected = false;
  let stopped = true;
  let lastEventId: string | undefined;
  let currentBackoff = reconnectMinMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;

  // If external signal fires, stop everything
  externalSignal?.addEventListener("abort", () => stop(), { once: true });

  function notify(): void {
    for (const handler of handlers) {
      handler();
    }
  }

  function resetKeepalive(): void {
    if (keepaliveTimer !== undefined) clearTimeout(keepaliveTimer);
    if (stopped) return;
    keepaliveTimer = setTimeout(() => {
      // No data received within timeout — connection is dead
      abortController?.abort();
    }, keepaliveTimeoutMs);
  }

  async function connect(): Promise<void> {
    if (stopped) return;

    abortController = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "X-Agent-Id": agentId,
      ...(authToken !== undefined ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(lastEventId !== undefined ? { "Last-Event-ID": lastEventId } : {}),
    };

    try {
      const response = await fetchImpl(url, {
        headers,
        signal: abortController.signal,
      });

      if (!response.ok || response.body === null) {
        throw new Error(`SSE connection failed: ${String(response.status)}`);
      }

      isConnected = true;
      currentBackoff = reconnectMinMs;
      resetKeepalive();

      for await (const event of parseSseStream(response.body)) {
        if (stopped) break;
        resetKeepalive();

        if (event.id !== undefined) lastEventId = event.id;
        if (event.retry !== undefined) currentBackoff = event.retry;

        // Any data event triggers notification — adapter decides what to fetch
        notify();
      }
    } catch (err: unknown) {
      // AbortError from our own abort is expected, not a failure
      if (err instanceof DOMException && err.name === "AbortError" && stopped) {
        return;
      }
    } finally {
      isConnected = false;
      if (keepaliveTimer !== undefined) clearTimeout(keepaliveTimer);
    }

    // Schedule reconnect if not stopped
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      currentBackoff = Math.min(currentBackoff * 2, reconnectMaxMs);
      void connect();
    }, currentBackoff);
  }

  function start(): void {
    if (!stopped) return;
    stopped = false;
    currentBackoff = reconnectMinMs;
    void connect();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (keepaliveTimer !== undefined) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    abortController?.abort();
    isConnected = false;
  }

  const onNotification = (handler: () => void): (() => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  };

  return {
    onNotification,
    start,
    stop,
    connected: () => isConnected,
  };
}
