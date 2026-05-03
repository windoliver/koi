import type { KoiError } from "@koi/core";
import type { WsClientFrame, WsEvent, WsTopic } from "@koi/dashboard-types";
import { isWsEvent } from "@koi/dashboard-types";
import { clientError } from "./errors.js";

/**
 * Minimal WebSocket-shaped contract — what we use from the standard lib.
 * Letting callers inject this keeps the package runtime-agnostic (Bun/Node 22+/browser/test).
 */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(event: "message", handler: (e: { data: unknown }) => void): void;
  addEventListener(event: "open", handler: () => void): void;
  addEventListener(event: "close", handler: () => void): void;
  addEventListener(event: "error", handler: (e: unknown) => void): void;
}

export type WsFactory = (url: string) => WsLike;

export type Unsubscribe = () => void;

export interface SubscriptionHandlers {
  /** Called for every typed event delivered by the server. */
  readonly onEvent: (event: WsEvent) => void;
  /**
   * Called once if the socket fails to open or errors after opening.
   * Consumers should mark cached data stale and decide whether to resubscribe.
   */
  readonly onError?: (error: KoiError) => void;
  /**
   * Called once when the socket closes for a reason the caller did NOT
   * initiate (server hangup, network drop). Caller-initiated teardown does
   * NOT fire this — the caller already knows it ended the subscription, so
   * reconnect logic can treat `onClose` as a remote-only signal.
   */
  readonly onClose?: () => void;
}

/**
 * Open a WebSocket, send a `subscribe` frame for `topics`, and dispatch every
 * matching server event to `handlers.onEvent`. Unknown frames are silently dropped
 * (forward compatibility). `onError` and `onClose` fire at most once each so
 * callers can detect dead subscriptions instead of staring at stale data.
 *
 * Returns a teardown that closes the socket.
 */
export function openSubscription(
  factory: WsFactory,
  url: string,
  topics: readonly WsTopic[],
  handlers: SubscriptionHandlers,
): Unsubscribe {
  const socket = factory(url);
  let opened = false;
  let pendingClose = false;
  // Stops `onEvent` delivery after teardown/error/close. Set as soon as the
  // subscription becomes dead so queued message events (browsers and Bun can
  // both buffer these) cannot reach the caller after unsubscribe.
  let messagesSilenced = false;
  // Ensures `onError` and `onClose` each fire at most once per subscription.
  let terminalDelivered = false;
  // True iff teardown was caller-initiated; suppresses `onClose` so reconnect
  // logic can treat the callback as a remote-only signal.
  let callerTorndown = false;

  const subscribeFrame: WsClientFrame = { v: 1, kind: "subscribe", topics };

  const fireError = (error: KoiError): void => {
    if (terminalDelivered) return;
    terminalDelivered = true;
    messagesSilenced = true;
    if (callerTorndown) return; // caller already disposed; suppress terminal
    handlers.onError?.(error);
  };
  const fireClose = (): void => {
    if (terminalDelivered) return;
    terminalDelivered = true;
    messagesSilenced = true;
    if (callerTorndown) return; // caller already disposed; suppress terminal
    handlers.onClose?.();
  };

  socket.addEventListener("open", () => {
    opened = true;
    if (pendingClose) {
      socket.close();
      return;
    }
    socket.send(JSON.stringify(subscribeFrame));
  });

  socket.addEventListener("message", (e) => {
    if (messagesSilenced) return;
    const parsed = parseFrame(e.data);
    if (parsed !== undefined) handlers.onEvent(parsed);
  });

  socket.addEventListener("error", (cause) => {
    fireError(clientError("EXTERNAL", `WebSocket error on ${url}`, { cause, retryable: true }));
    // Close the socket explicitly so we never end up in the half-dead state
    // where messagesSilenced is true but the socket is still open and would
    // never deliver the terminal `close` to the caller.
    try {
      socket.close();
    } catch {
      // Some implementations throw if the socket is already closed; ignore.
    }
  });

  // Fires once for any close — caller-initiated teardown or remote close —
  // so consumers can mark dashboards stale via a single terminal signal.
  socket.addEventListener("close", () => {
    fireClose();
  });

  return () => {
    // Silence late frames immediately and tag this teardown as caller-driven
    // so the upcoming `close` event does not surface as `onClose` — the
    // caller already knows it ended the subscription.
    messagesSilenced = true;
    callerTorndown = true;
    if (opened) {
      socket.close();
    } else {
      pendingClose = true;
    }
  };
}

function parseFrame(raw: unknown): WsEvent | undefined {
  const text = typeof raw === "string" ? raw : undefined;
  if (text === undefined) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isWsEvent(body) ? body : undefined;
}
