/**
 * JSON-RPC 2.0 framing for LSP communication — Bun-native streams version.
 *
 * Implements Content-Length header parsing, request/response/notification
 * message types, and concurrent request tracking with id-based routing.
 * Uses WHATWG ReadableStream and Bun FileSink instead of Node.js streams.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// Connection interface
// ---------------------------------------------------------------------------

export interface JsonRpcConnection {
  readonly sendRequest: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  readonly sendNotification: (method: string, params?: unknown) => void;
  readonly onNotification: (method: string, handler: (params: unknown) => void) => () => void;
  readonly onRequest: (method: string, handler: (params: unknown) => unknown) => () => void;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Content-Length framing
// ---------------------------------------------------------------------------

const HEADER_DELIMITER = "\r\n\r\n";
const CONTENT_LENGTH_PREFIX = "Content-Length: ";
const encoder = new TextEncoder();

/**
 * Writes a JSON-RPC message with Content-Length header framing to a Bun FileSink.
 */
export function writeMessage(stdin: import("bun").FileSink, message: JsonRpcMessage): void {
  const body = JSON.stringify(message);
  const bodyBytes = encoder.encode(body);
  const header = `${CONTENT_LENGTH_PREFIX}${bodyBytes.byteLength}${HEADER_DELIMITER}`;
  stdin.write(encoder.encode(header + body));
  stdin.flush();
}

/** Maximum buffer size (10 MB) to prevent unbounded memory growth. */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

const HEADER_DELIMITER_BUF = new Uint8Array(Buffer.from(HEADER_DELIMITER));

/**
 * Creates a streaming parser that extracts JSON-RPC messages from a
 * Content-Length framed byte stream.
 *
 * Works with raw Buffers throughout to ensure byte-accurate Content-Length
 * handling (avoids character vs. byte mismatch with multi-byte UTF-8).
 */
export function createMessageParser(
  onMessage: (message: JsonRpcMessage) => void,
): (chunk: Uint8Array) => void {
  // let is justified: parser accumulates buffered data across chunks
  let buffer = Buffer.alloc(0);

  return (chunk: Uint8Array): void => {
    buffer = Buffer.concat([new Uint8Array(buffer), chunk]);

    // Guard against unbounded memory growth from misbehaving servers
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer = Buffer.alloc(0);
      return;
    }

    // Process all complete messages in the buffer
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_DELIMITER_BUF);
      if (headerEnd === -1) break;

      const headerSection = buffer.subarray(0, headerEnd).toString("utf-8");
      const contentLengthLine = headerSection
        .split("\r\n")
        .find((line) => line.startsWith(CONTENT_LENGTH_PREFIX));

      if (contentLengthLine === undefined) {
        // Malformed header — skip to after the delimiter
        buffer = buffer.subarray(headerEnd + HEADER_DELIMITER_BUF.length);
        continue;
      }

      const contentLength = Number.parseInt(
        contentLengthLine.slice(CONTENT_LENGTH_PREFIX.length),
        10,
      );

      if (Number.isNaN(contentLength)) {
        buffer = buffer.subarray(headerEnd + HEADER_DELIMITER_BUF.length);
        continue;
      }

      const bodyStart = headerEnd + HEADER_DELIMITER_BUF.length;

      // Wait for full body (byte-accurate comparison)
      if (buffer.length - bodyStart < contentLength) break;

      const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      buffer = buffer.subarray(bodyStart + contentLength);

      try {
        const parsed: unknown = JSON.parse(body);
        if (isJsonRpcMessage(parsed)) {
          onMessage(parsed);
        }
      } catch {
        // Malformed JSON — skip this message
        void 0;
      }
    }
  };
}

/** Minimal type guard for JSON-RPC messages. */
function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null && "jsonrpc" in value;
}

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Creates a JSON-RPC connection over Bun streams.
 *
 * Supports concurrent requests with id-based routing, notification
 * subscriptions, and per-request timeouts.
 * Starts consuming the ReadableStream immediately in a background task.
 */
export function createJsonRpcConnection(
  stdout: ReadableStream<Uint8Array>,
  stdin: import("bun").FileSink,
): JsonRpcConnection {
  // let is justified: auto-incrementing request id
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  const requestHandlers = new Map<string, (params: unknown) => unknown>();
  // let is justified: tracks disposal state
  let disposed = false;

  const handleMessage = (message: JsonRpcMessage): void => {
    if (disposed) return;

    // Response — has 'id' and ('result' or 'error') but NO 'method'
    if ("id" in message && !("method" in message) && ("result" in message || "error" in message)) {
      const id = (message as { readonly id: number }).id;
      const pendingReq = pending.get(id);
      if (pendingReq === undefined) return;

      pending.delete(id);
      clearTimeout(pendingReq.timer);

      if ("error" in message && message.error !== undefined) {
        const err = message.error as { readonly code: number; readonly message: string };
        pendingReq.reject(new Error(`JSON-RPC error ${err.code}: ${err.message}`));
      } else {
        pendingReq.resolve("result" in message ? message.result : undefined);
      }
      return;
    }

    // Server request — has 'id' AND 'method' (server is asking the client something)
    if ("id" in message && "method" in message) {
      const id = (message as { readonly id: number }).id;
      const method = (message as { readonly method: string }).method;
      const handler = requestHandlers.get(method);
      const params = "params" in message ? message.params : undefined;
      // let is justified: result varies by handler presence
      let result: unknown = null;
      if (handler !== undefined) {
        try {
          result = handler(params);
        } catch {
          result = null;
        }
      }
      writeMessage(stdin, { jsonrpc: "2.0", id, result });
      return;
    }

    // Notification — has 'method' but no 'id'
    if ("method" in message && !("id" in message)) {
      const method = (message as { readonly method: string }).method;
      const handlers = notificationHandlers.get(method);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          handler("params" in message ? message.params : undefined);
        }
      }
    }
  };

  const parser = createMessageParser(handleMessage);

  // Start consuming the ReadableStream in a background async loop
  void (async () => {
    try {
      for await (const chunk of stdout) {
        if (disposed) break;
        parser(chunk);
      }
    } catch {
      // Stream ended or was cancelled — normal on dispose
    }
  })();

  const sendRequest = <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error("Connection disposed"));
    }

    const id = nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const effectiveTimeout = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request timeout after ${effectiveTimeout}ms: ${method}`));
      }, effectiveTimeout);

      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      writeMessage(stdin, request);
    });
  };

  const sendNotification = (method: string, params?: unknown): void => {
    if (disposed) return;

    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };

    writeMessage(stdin, notification);
  };

  const onNotification = (method: string, handler: (params: unknown) => void): (() => void) => {
    const handlers = notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    notificationHandlers.set(method, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        notificationHandlers.delete(method);
      }
    };
  };

  const onRequest = (method: string, handler: (params: unknown) => unknown): (() => void) => {
    requestHandlers.set(method, handler);
    return () => {
      requestHandlers.delete(method);
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    for (const [id, pendingReq] of pending) {
      clearTimeout(pendingReq.timer);
      pendingReq.reject(new Error("Connection disposed"));
      pending.delete(id);
    }

    notificationHandlers.clear();
    requestHandlers.clear();
  };

  return { sendRequest, sendNotification, onNotification, onRequest, dispose };
}
