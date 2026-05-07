export type LineReaderEvent = string;

export interface LineReaderOptions {
  readonly maxLineBytes?: number;
  readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
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
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let totalBytes = 0;
  let dropping = false;

  function emitLine(line: string): {
    readonly emitted: string | undefined;
    readonly stop: boolean;
  } {
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      return { emitted: undefined, stop: true };
    }

    const cappedLine = clampPrefix(line, maxLineBytes);
    const output = clampPrefix(cappedLine, remainingBytes);
    const outputBytes = encoder.encode(output).byteLength;
    if (outputBytes === 0 && line.length > 0) {
      return { emitted: undefined, stop: true };
    }

    totalBytes += outputBytes;
    return {
      emitted: output,
      stop: totalBytes >= maxTotalBytes,
    };
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (!dropping) {
          const tail = clampPrefix(buffer.replace(/\r$/, ""), maxLineBytes);
          if (tail.length > 0) {
            const { emitted, stop } = emitLine(tail);
            if (emitted !== undefined) {
              yield emitted;
            }
            if (stop) {
              return;
            }
          }
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        if (dropping) {
          buffer = buffer.slice(newlineIndex + 1);
          dropping = false;
          continue;
        }

        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);

        const { emitted, stop } = emitLine(rawLine);
        if (emitted !== undefined) {
          yield emitted;
        }
        if (stop) {
          return;
        }
      }

      if (!dropping && encoder.encode(buffer).byteLength > maxLineBytes) {
        dropping = true;
        buffer = "";
      } else if (dropping) {
        buffer = "";
      }
    }
  } finally {
    reader.releaseLock();
  }
}
