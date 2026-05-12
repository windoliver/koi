import type { KoiError } from "@koi/core";
import type { WsEvent, WsTopic } from "@koi/dashboard-types";
import { isWsEvent } from "@koi/dashboard-types";
import { clientError } from "./errors.js";
import type { FetchLike } from "./http.js";

export interface SseConnection {
  close(): void;
}

export interface SseAdapter {
  open(baseUrl: string, topics: readonly WsTopic[], handlers: SubscriptionHandlers): SseConnection;
}

/**
 * Back-compat shim for the old websocket-shaped types.
 * Live subscriptions are SSE-only; these aliases exist so downstream code
 * that still references the public names can continue to typecheck.
 */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(event: "message", handler: (e: { data: unknown }) => void): void;
  addEventListener(event: "open", handler: () => void): void;
  addEventListener(event: "close", handler: () => void): void;
  addEventListener(event: "error", handler: (e: unknown) => void): void;
}

/** Back-compat alias for consumers that still name the old factory type. */
export type WsFactory = (url: string) => WsLike;

export type Unsubscribe = () => void;

export interface SubscriptionHandlers {
  /** Called for every typed event delivered by the server. */
  readonly onEvent: (event: WsEvent) => void;
  /**
   * Called once if the stream fails after opening.
   * Consumers should mark cached data stale and decide whether to resubscribe.
   */
  readonly onError?: (error: KoiError) => void;
  /**
   * Called once when the remote stream ends for a reason the caller did NOT
   * initiate. Caller-initiated teardown does NOT fire this.
   */
  readonly onClose?: () => void;
}

/**
 * Open a subscription, encode the topic list into the adapter, and return a
 * teardown that closes the underlying connection.
 */
export function openSubscription(
  adapter: SseAdapter,
  baseUrl: string,
  topics: readonly WsTopic[],
  handlers: SubscriptionHandlers,
): Unsubscribe {
  const connection = adapter.open(baseUrl, topics, handlers);
  return () => connection.close();
}

export function createFetchSseAdapter(fetchImpl: FetchLike): SseAdapter {
  return new FetchSseAdapter(fetchImpl);
}

class FetchSseAdapter implements SseAdapter {
  readonly #fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike) {
    this.#fetchImpl = fetchImpl;
  }

  open(baseUrl: string, topics: readonly WsTopic[], handlers: SubscriptionHandlers): SseConnection {
    return new FetchSseConnection(this.#fetchImpl, baseUrl, topics, handlers);
  }
}

class FetchSseConnection implements SseConnection {
  readonly #fetchImpl: FetchLike;
  readonly #baseUrl: string;
  readonly #topics: readonly WsTopic[];
  readonly #handlers: SubscriptionHandlers;
  readonly #controller = new AbortController();
  #closedByCaller = false;
  #terminalDelivered = false;

  constructor(
    fetchImpl: FetchLike,
    baseUrl: string,
    topics: readonly WsTopic[],
    handlers: SubscriptionHandlers,
  ) {
    this.#fetchImpl = fetchImpl;
    this.#baseUrl = stripTrailingSlash(baseUrl);
    this.#topics = topics;
    this.#handlers = handlers;
    void this.#run();
  }

  close(): void {
    if (this.#closedByCaller) return;
    this.#closedByCaller = true;
    this.#controller.abort();
  }

  async #run(): Promise<void> {
    const eventsUrl = buildEventsUrl(this.#baseUrl, this.#topics);
    let body: ReadableStream<Uint8Array<ArrayBufferLike>> | null = null;
    try {
      const response = await this.#fetchImpl(eventsUrl, {
        headers: { accept: "text/event-stream" },
        signal: this.#controller.signal,
      });
      if (this.#closedByCaller) return;
      body = response.body as ReadableStream<Uint8Array<ArrayBufferLike>> | null;
      if (!response.ok) {
        await cancelBody(body);
        this.#fireError(
          clientError("EXTERNAL", `SSE stream error on ${eventsUrl}`, { retryable: true }),
        );
        return;
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) {
        await cancelBody(body);
        this.#fireError(
          clientError("EXTERNAL", `SSE stream content-type mismatch on ${eventsUrl}`, {
            retryable: true,
          }),
        );
        return;
      }
      if (body === null) {
        await cancelBody(body);
        this.#fireError(
          clientError("EXTERNAL", `SSE stream missing body on ${eventsUrl}`, {
            retryable: true,
          }),
        );
        return;
      }
      await pumpSseStream(body, this.#handlers);
      if (!this.#closedByCaller) this.#fireClose();
    } catch (cause) {
      if (isAbortError(cause) && this.#closedByCaller) return;
      await cancelBody(body);
      this.#fireError(
        clientError("EXTERNAL", `SSE stream error on ${eventsUrl}`, {
          cause,
          retryable: true,
        }),
      );
    }
  }

  #fireError(error: KoiError): void {
    if (this.#terminalDelivered) return;
    this.#terminalDelivered = true;
    if (this.#closedByCaller) return;
    this.#controller.abort();
    this.#handlers.onError?.(error);
  }

  #fireClose(): void {
    if (this.#terminalDelivered) return;
    this.#terminalDelivered = true;
    if (this.#closedByCaller) return;
    this.#handlers.onClose?.();
  }
}

async function pumpSseStream(
  body: ReadableStream<Uint8Array<ArrayBufferLike>>,
  handlers: SubscriptionHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];
  // Server batch `seq` is monotonic per connection. Track only the highest seq
  // seen instead of every seen value so long-lived dashboards do not accumulate
  // one Set entry per flush forever.
  const seqState = { lastSeen: -1 };
  const flushFrame = (): void => {
    if (eventType === "batch" && dataLines.length > 0) {
      dispatchBatch(dataLines.join("\n"), handlers, seqState);
    }
    eventType = "";
    dataLines = [];
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          flushFrame();
        } else if (!line.startsWith(":")) {
          const colonIndex = line.indexOf(":");
          const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
          let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") {
            eventType = value;
          } else if (field === "data") {
            dataLines.push(value);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    flushFrame();
  } finally {
    reader.releaseLock();
  }
}

async function cancelBody(body: ReadableStream<Uint8Array<ArrayBufferLike>> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Ignored: stream may already be closed, errored, or locked in teardown.
  }
}

function dispatchBatch(
  raw: string,
  handlers: SubscriptionHandlers,
  seqState: { lastSeen: number },
): void {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isBatchFrame(body)) return;
  if (body.seq <= seqState.lastSeen) return;
  seqState.lastSeen = body.seq;
  for (const event of body.events) {
    if (isWsEvent(event)) handlers.onEvent(event);
  }
}

function isBatchFrame(x: unknown): x is {
  readonly seq: number;
  readonly timestampMs: number;
  readonly events: readonly WsEvent[];
} {
  return (
    isObject(x) &&
    typeof x.seq === "number" &&
    typeof x.timestampMs === "number" &&
    Array.isArray(x.events)
  );
}

function buildEventsUrl(baseUrl: string, topics: readonly WsTopic[]): string {
  const url = new URL(`${stripTrailingSlash(baseUrl)}/api/events`);
  url.searchParams.set("topics", topics.join(","));
  return url.toString();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isAbortError(cause: unknown): boolean {
  return isObject(cause) && cause.name === "AbortError";
}

function isObject(x: unknown): x is Readonly<Record<string, unknown>> {
  return typeof x === "object" && x !== null;
}
