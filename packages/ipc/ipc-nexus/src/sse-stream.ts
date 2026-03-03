/**
 * Pure SSE parser — async generator that yields parsed events
 * from a ReadableStream<Uint8Array>.
 *
 * Handles:
 * - Chunk boundaries (SSE fields split across chunks)
 * - Comment lines (`:keepalive`, etc.) — ignored
 * - Multi-line `data:` concatenation per SSE spec
 * - `retry:` field parsing
 * - Event boundary on double-newline
 *
 * Zero dependencies — operates on Web Streams API.
 */

/** A parsed SSE event. */
export interface SseEvent {
  readonly id?: string | undefined;
  readonly event?: string | undefined;
  readonly data: string;
  readonly retry?: number | undefined;
}

/**
 * Parse an SSE byte stream into discrete events.
 *
 * Yields one SseEvent per double-newline-delimited block.
 * Skips comment-only blocks (no data field set).
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  // let justified: accumulates partial lines across chunks
  let leftover = "";
  // let justified: mutable event fields reset per event boundary
  let eventId: string | undefined;
  let eventType: string | undefined;
  // Mutation justified: local accumulator in streaming parser, not shared state
  let dataLines: string[] = [];
  let retryMs: number | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      // Last element may be a partial line — save for next chunk
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          // Event boundary: double-newline
          if (dataLines.length > 0) {
            yield {
              ...(eventId !== undefined ? { id: eventId } : {}),
              ...(eventType !== undefined ? { event: eventType } : {}),
              data: dataLines.join("\n"),
              ...(retryMs !== undefined ? { retry: retryMs } : {}),
            };
          }
          // Reset for next event
          eventId = undefined;
          eventType = undefined;
          dataLines = [];
          retryMs = undefined;
          continue;
        }

        // Comment line — ignore
        if (line.startsWith(":")) continue;

        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) {
          // Field with no value — treat as empty value per spec
          processField(line, "");
          continue;
        }

        const field = line.slice(0, colonIndex);
        // Strip single leading space after colon per SSE spec
        const rawValue = line.slice(colonIndex + 1);
        const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
        processField(field, fieldValue);
      }
    }

    // Process any remaining leftover as a final line
    if (leftover !== "") {
      if (!leftover.startsWith(":")) {
        const colonIndex = leftover.indexOf(":");
        if (colonIndex === -1) {
          processField(leftover, "");
        } else {
          const field = leftover.slice(0, colonIndex);
          const rawValue = leftover.slice(colonIndex + 1);
          const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
          processField(field, fieldValue);
        }
      }
    }

    // Flush remaining data if stream ends without trailing newline
    if (dataLines.length > 0) {
      yield {
        ...(eventId !== undefined ? { id: eventId } : {}),
        ...(eventType !== undefined ? { event: eventType } : {}),
        data: dataLines.join("\n"),
        ...(retryMs !== undefined ? { retry: retryMs } : {}),
      };
    }
  } finally {
    reader.releaseLock();
  }

  function processField(field: string, value: string): void {
    switch (field) {
      case "id":
        eventId = value;
        break;
      case "event":
        eventType = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) retryMs = parsed;
        break;
      }
      // Unknown fields are ignored per spec
    }
  }
}
