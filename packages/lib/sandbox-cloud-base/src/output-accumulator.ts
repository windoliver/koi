export type OutputAccumulatorChunk = string;

export interface OutputAccumulator {
  readonly append: (chunk: OutputAccumulatorChunk) => void;
  readonly result: () => {
    readonly output: string;
    readonly truncated: boolean;
  };
}

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function prefixByBytes(chunk: string, maxBytes: number): string {
  if (maxBytes <= 0 || chunk.length === 0) {
    return "";
  }

  let end = chunk.length;
  while (end > 0 && encoder.encode(chunk.slice(0, end)).byteLength > maxBytes) {
    end -= 1;
  }
  return chunk.slice(0, end);
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

      const chunkBytes = encoder.encode(chunk).byteLength;
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
