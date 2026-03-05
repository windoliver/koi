/**
 * Line-buffered reader for NDJSON-over-pipe with backpressure caps.
 *
 * Reads from a ReadableStream<Uint8Array>, yields complete lines (split on \n),
 * and enforces per-line and total byte limits to prevent memory exhaustion from
 * misbehaving child processes.
 */

/** Default maximum bytes per line: 1 MB. */
export const DEFAULT_MAX_LINE_BYTES: number = 1 * 1024 * 1024;

/** Default maximum total bytes across all lines: 10 MB. */
export const DEFAULT_MAX_TOTAL_BYTES: number = 10 * 1024 * 1024;

export interface LineReaderOptions {
  /** Maximum bytes per line. Lines exceeding this are truncated. Default: 1 MB. */
  readonly maxLineBytes?: number;
  /** Maximum total bytes yielded. Reader stops after this limit. Default: 10 MB. */
  readonly maxTotalBytes?: number;
}

/**
 * Create an async generator that yields complete lines from a byte stream.
 *
 * - Splits on `\n` (handles `\r\n` by trimming trailing `\r`)
 * - Truncates individual lines exceeding `maxLineBytes`
 * - Stops yielding after `maxTotalBytes` total output
 * - Flushes any trailing partial line on stream end
 */
export async function* createLineReader(
  stream: ReadableStream<Uint8Array>,
  options?: LineReaderOptions,
): AsyncGenerator<string, void, undefined> {
  const maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const decoder = new TextDecoder();

  // let — mutable accumulation state
  let buffer = "";
  let totalBytes = 0;

  for await (const chunk of stream) {
    if (totalBytes >= maxTotalBytes) return;

    buffer += decoder.decode(chunk, { stream: true });

    // Process all complete lines in the buffer
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      // let — line may be truncated below
      let line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      // Strip trailing \r for \r\n line endings
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      // Truncate oversized lines
      if (line.length > maxLineBytes) {
        line = line.slice(0, maxLineBytes);
      }

      totalBytes += line.length;
      if (totalBytes > maxTotalBytes) return;

      yield line;

      newlineIdx = buffer.indexOf("\n");
    }

    // If buffer itself exceeds maxLineBytes (no newline yet), truncate eagerly
    if (buffer.length > maxLineBytes) {
      buffer = buffer.slice(0, maxLineBytes);
    }
  }

  // Flush any remaining partial line
  if (buffer.length > 0 && totalBytes < maxTotalBytes) {
    if (buffer.endsWith("\r")) {
      buffer = buffer.slice(0, -1);
    }
    if (buffer.length > maxLineBytes) {
      buffer = buffer.slice(0, maxLineBytes);
    }
    if (buffer.length > 0) {
      yield buffer;
    }
  }
}
