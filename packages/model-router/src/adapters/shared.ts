/**
 * Shared HTTP + SSE utilities for provider adapters.
 *
 * Consolidates fetch-with-timeout, SSE stream parsing, retry-after parsing,
 * and abort error handling to eliminate duplication across adapters.
 */

import type { KoiError } from "@koi/core";

// ---------------------------------------------------------------------------
// Fetch with timeout + signal composition
// ---------------------------------------------------------------------------

export interface FetchWithTimeoutOptions {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface FetchWithTimeoutResult {
  readonly response: Response;
  readonly clearTimer: () => void;
}

/**
 * Fetches a URL with a timeout and optional caller-provided AbortSignal.
 *
 * Composes the caller signal with an internal timeout AbortController via
 * `AbortSignal.any()`. Returns the response and a `clearTimer` callback
 * that the caller must invoke to prevent timer leaks.
 */
export async function fetchWithTimeout(
  options: FetchWithTimeoutOptions,
): Promise<FetchWithTimeoutResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const effectiveSignal =
    options.signal !== undefined
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

  const response = await fetch(options.url, {
    method: options.method,
    headers: { ...options.headers },
    ...(options.body !== undefined ? { body: options.body } : {}),
    signal: effectiveSignal,
  });

  return {
    response,
    clearTimer: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// Idle-timeout streaming fetch
// ---------------------------------------------------------------------------

export interface StreamFetchOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface StreamFetchResult {
  readonly response: Response;
  readonly resetTimer: () => void;
  readonly clearTimer: () => void;
}

/**
 * Fetches a URL for streaming with an idle timeout that resets on each chunk.
 *
 * Unlike `fetchWithTimeout`, the timer resets every time `resetTimer()` is
 * called, so long-running healthy streams are not killed.
 */
export async function streamFetch(options: StreamFetchOptions): Promise<StreamFetchResult> {
  const controller = new AbortController();
  // let: idle timer, encapsulated — resets on each SSE chunk
  let timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const resetTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
  };

  const effectiveSignal =
    options.signal !== undefined
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

  const response = await fetch(options.url, {
    method: "POST",
    headers: { ...options.headers },
    body: options.body,
    signal: effectiveSignal,
  });

  return {
    response,
    resetTimer,
    clearTimer: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// Abort error discrimination
// ---------------------------------------------------------------------------

/**
 * Discriminates caller-initiated abort from internal timeout and returns
 * a typed KoiError.
 */
export function handleAbortError(
  error: unknown,
  providerName: string,
  timeoutMs: number,
  callerSignal?: AbortSignal | undefined,
): KoiError {
  if (error instanceof DOMException && error.name === "AbortError") {
    const isCallerAbort = callerSignal?.aborted === true;
    return {
      code: isCallerAbort ? "EXTERNAL" : "TIMEOUT",
      message: isCallerAbort
        ? `${providerName} request cancelled`
        : `${providerName} request timed out after ${timeoutMs}ms`,
      retryable: !isCallerAbort,
    };
  }
  // Not an abort error — re-throw as-is
  throw error;
}

/**
 * Variant of handleAbortError for streaming, which uses "stream" language.
 */
export function handleStreamAbortError(
  error: unknown,
  providerName: string,
  timeoutMs: number,
  callerSignal?: AbortSignal | undefined,
): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    const isCallerAbort = callerSignal?.aborted === true;
    return isCallerAbort
      ? `${providerName} stream cancelled`
      : `${providerName} stream idle timeout after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// HTTP status → KoiErrorCode mapping
// ---------------------------------------------------------------------------

/**
 * Maps an HTTP status code to a KoiErrorCode.
 */
export function mapStatusToErrorCode(status: number): KoiError["code"] {
  if (status === 401 || status === 403) return "PERMISSION";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "EXTERNAL";
  return "EXTERNAL";
}

// ---------------------------------------------------------------------------
// Retry-After header parsing
// ---------------------------------------------------------------------------

/**
 * Extracts Retry-After header value as milliseconds.
 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isNaN(seconds)) return undefined;
  return Math.ceil(seconds * 1000);
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

/**
 * Generic SSE stream parser. Reads chunks from a ReadableStream, buffers
 * lines, and yields parsed events via the provided `parseLine` callback.
 *
 * @param body - The response body stream
 * @param parseLine - Parses a `data: ...` payload string into T, or undefined to skip
 * @param onChunk - Called on each raw chunk for idle timeout reset
 */
export async function* parseSSEStream<T>(
  body: ReadableStream<Uint8Array>,
  parseLine: (data: string) => T | undefined,
  onChunk?: () => void,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // let: line buffer accumulates partial lines across chunks
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);

        const parsed = parseLine(data);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
