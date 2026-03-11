/**
 * Custom SSE (Server-Sent Events) parser for streaming admin API events.
 *
 * Written instead of using a library because:
 * 1. It's ~70 lines of logic — well under the "50 lines → write it yourself" threshold
 * 2. We need full control over edge cases (split chunks, reconnection, UTF-8)
 * 3. The parser is on the critical path — bugs here cause silent data loss
 *
 * Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

/** Parsed SSE event. */
export interface SSEEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string;
  readonly retry: number | undefined;
}

/**
 * Stateful SSE parser that handles chunk boundaries correctly.
 *
 * Feed it raw string chunks from a ReadableStream and it will
 * yield complete SSE events. Handles:
 * - Events split across chunks
 * - Multiple events in one chunk
 * - Multi-line data fields (joined with \n)
 * - Comment lines (: prefix) — silently discarded
 * - Empty lines as event terminators
 * - id and retry fields
 */
export class SSEParser {
  private buffer = "";
  private eventType = "";
  private dataLines: string[] = [];
  private lastEventId = "";
  private retryMs: number | undefined;

  /** The last received event ID (for reconnection with Last-Event-ID header). */
  get lastId(): string {
    return this.lastEventId;
  }

  /**
   * Feed a raw chunk of text from the stream.
   * Returns zero or more complete SSE events.
   */
  feed(chunk: string): readonly SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    // Process complete lines (terminated by \n, \r, or \r\n)
    let lineEnd: number = findLineEnd(this.buffer);
    while (lineEnd !== -1) {
      const line = this.buffer.slice(0, lineEnd);
      // Advance past the line ending (\r\n counts as one terminator)
      const skip = this.buffer[lineEnd] === "\r" && this.buffer[lineEnd + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(lineEnd + skip);

      if (line === "") {
        // Empty line → dispatch event if we have data
        if (this.dataLines.length > 0) {
          const event: SSEEvent = {
            event: this.eventType || "message",
            data: this.dataLines.join("\n"),
            id: this.lastEventId,
            retry: this.retryMs,
          };
          events.push(event);
        }
        // Reset per-event fields (not lastEventId — that persists)
        this.eventType = "";
        this.dataLines = [];
        this.retryMs = undefined;
      } else {
        this.processLine(line);
      }
      lineEnd = findLineEnd(this.buffer);
    }

    return events;
  }

  /** Reset parser state (for reconnection). Preserves lastEventId. */
  reset(): void {
    this.buffer = "";
    this.eventType = "";
    this.dataLines = [];
    this.retryMs = undefined;
  }

  private processLine(line: string): void {
    // Comment line
    if (line.startsWith(":")) {
      return;
    }

    const colonIndex = line.indexOf(":");
    let field: string;
    let value: string;

    if (colonIndex === -1) {
      // Field-only line (no colon) — value is empty string
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIndex);
      // Strip single leading space after colon (per spec)
      const valueStart = line[colonIndex + 1] === " " ? colonIndex + 2 : colonIndex + 1;
      value = line.slice(valueStart);
    }

    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        // Per spec: ignore if value contains null character
        if (!value.includes("\0")) {
          this.lastEventId = value;
        }
        break;
      case "retry": {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          this.retryMs = parsed;
        }
        break;
      }
      // Unknown fields are silently ignored per spec
    }
  }
}

/** Find the index of the first line ending (\n or \r) in the string. */
function findLineEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n" || s[i] === "\r") {
      return i;
    }
  }
  return -1;
}

// ─── Stream Consumer ─────────────────────────────────────────────────

/** Options for consuming an SSE stream. */
export interface SSEStreamOptions {
  /** Called for each parsed SSE event. */
  readonly onEvent: (event: SSEEvent) => void;
  /** Called when the stream closes normally. */
  readonly onClose?: () => void;
  /** Called when the stream errors. */
  readonly onError?: (error: unknown) => void;
  /** AbortSignal to cancel the stream. */
  readonly signal?: AbortSignal;
}

/**
 * Consume an SSE stream from a fetch Response.
 *
 * Reads the response body as text chunks, parses SSE events,
 * and calls the provided callbacks.
 *
 * Returns the parser instance (for accessing lastId on reconnect).
 */
export async function consumeSSEStream(
  response: Response,
  options: SSEStreamOptions,
): Promise<SSEParser> {
  const parser = new SSEParser();
  const body = response.body;
  if (body === null) {
    options.onClose?.();
    return parser;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  // Cancel the reader when the abort signal fires (even mid-read)
  const onAbort = (): void => {
    reader.cancel().catch(() => {
      /* intentional: ignore cancel errors on abort */
    });
  };
  if (options.signal?.aborted === true) {
    options.onClose?.();
    return parser;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const events = parser.feed(chunk);
      for (const event of events) {
        options.onEvent(event);
      }
    }
    options.onClose?.();
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      // AbortError is expected when signal fires
      options.onClose?.();
    } else {
      options.onError?.(error);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  return parser;
}
