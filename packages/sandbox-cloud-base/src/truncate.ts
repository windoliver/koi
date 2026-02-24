/**
 * Output accumulator with configurable byte limit and truncation detection.
 *
 * Cloud sandbox output can be very large. This utility collects streamed
 * chunks and truncates at a configurable threshold.
 */

/** Default maximum output bytes: 10 MB. */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface OutputAccumulator {
  /** Append a chunk of output. No-op after limit is reached. */
  readonly append: (chunk: string) => void;
  /** Get the accumulated output and truncation status. */
  readonly result: () => {
    readonly output: string;
    readonly truncated: boolean;
  };
}

/**
 * Create an output accumulator with a byte limit.
 *
 * @param maxBytes - Maximum bytes to accumulate. Defaults to 10 MB.
 */
export function createOutputAccumulator(maxBytes?: number): OutputAccumulator {
  const limit = maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const encoder = new TextEncoder();

  // Mutable state — accumulating output
  let totalBytes = 0;
  let truncated = false;
  const chunks: string[] = [];

  return {
    append: (chunk: string): void => {
      if (truncated) return;

      const chunkBytes = encoder.encode(chunk).byteLength;
      if (totalBytes + chunkBytes > limit) {
        // Truncate: take only what fits
        const remaining = limit - totalBytes;
        if (remaining > 0) {
          // Approximate: slice by char ratio (UTF-8 may vary, but good enough)
          const ratio = remaining / chunkBytes;
          const sliceLen = Math.max(1, Math.floor(chunk.length * ratio));
          chunks.push(chunk.slice(0, sliceLen));
          totalBytes = limit;
        }
        truncated = true;
        return;
      }

      chunks.push(chunk);
      totalBytes += chunkBytes;
    },
    result: (): { readonly output: string; readonly truncated: boolean } => ({
      output: chunks.join(""),
      truncated,
    }),
  };
}
