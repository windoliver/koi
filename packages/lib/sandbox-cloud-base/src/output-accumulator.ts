export type OutputAccumulatorChunk = string;

export interface OutputAccumulator {
  readonly append: (chunk: OutputAccumulatorChunk) => void;
  readonly result: () => {
    readonly output: string;
    readonly truncated: boolean;
  };
}

export const DEFAULT_MAX_OUTPUT_BYTES: number = 10 * 1024 * 1024;

function prefixByBytes(chunk: string, maxBytes: number): string {
  if (maxBytes <= 0 || chunk.length === 0) {
    return "";
  }

  let prefix = "";
  for (const char of chunk) {
    const next = prefix + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      break;
    }
    prefix = next;
  }
  return prefix;
}

export function createOutputAccumulator(
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): OutputAccumulator {
  let bytes = 0;
  let truncated = false;
  const chunks: string[] = [];

  return {
    append(chunk: OutputAccumulatorChunk) {
      if (truncated) {
        return;
      }

      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (bytes + chunkBytes <= maxBytes) {
        chunks.push(chunk);
        bytes += chunkBytes;
        return;
      }

      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const prefix = prefixByBytes(chunk, remaining);
        if (prefix.length > 0) {
          chunks.push(prefix);
        }
      }
      bytes = maxBytes;
      truncated = true;
    },
    result() {
      return {
        output: chunks.join(""),
        truncated,
      };
    },
  };
}
