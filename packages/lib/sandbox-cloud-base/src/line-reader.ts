export type LineReaderEvent = string;

export interface LineReaderOptions {
  readonly maxLineBytes?: number;
  readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function clampPrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }

  let end = text.length;
  while (end > 0 && encoder.encode(text.slice(0, end)).byteLength > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end);
}

export async function* createLineReader(
  stream: ReadableStream<Uint8Array>,
  options?: LineReaderOptions,
): AsyncGenerator<LineReaderEvent, void, undefined> {
  const maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const reader = stream.getReader();
  let buffer = "";
  let totalBytes = 0;

  try {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        const line = clampPrefix(rawLine, maxLineBytes);
        totalBytes += encoder.encode(line).byteLength;
        if (totalBytes > maxTotalBytes) {
          return;
        }
        yield line;
        continue;
      }

      const { value, done } = await reader.read();
      if (done) {
        const tail = clampPrefix(buffer.replace(/\r$/, ""), maxLineBytes);
        if (tail.length > 0 && totalBytes < maxTotalBytes) {
          yield tail;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxLineBytes) {
        buffer = clampPrefix(buffer, maxLineBytes);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
