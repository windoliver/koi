import type { WsClientFrame, WsEvent, WsTopic } from "@koi/dashboard-types";
import { isWsEvent } from "@koi/dashboard-types";

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

/**
 * Open a WebSocket, send a `subscribe` frame for `topics`, and dispatch every
 * matching server event to `onEvent`. Unknown frames are silently dropped
 * (forward compatibility). Returns a teardown that closes the socket.
 */
export function openSubscription(
  factory: WsFactory,
  url: string,
  topics: readonly WsTopic[],
  onEvent: (event: WsEvent) => void,
): Unsubscribe {
  const socket = factory(url);
  let opened = false;
  let pendingClose = false;

  const subscribeFrame: WsClientFrame = { v: 1, kind: "subscribe", topics };

  socket.addEventListener("open", () => {
    opened = true;
    if (pendingClose) {
      socket.close();
      return;
    }
    socket.send(JSON.stringify(subscribeFrame));
  });

  socket.addEventListener("message", (e) => {
    const parsed = parseFrame(e.data);
    if (parsed !== undefined) onEvent(parsed);
  });

  return () => {
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
