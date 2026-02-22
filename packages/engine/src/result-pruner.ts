/**
 * Result pruning guard — truncates oversized tool outputs before they
 * re-enter the model's context window.
 *
 * Adopted from OpenClaw's context pruning pattern. Operates as a
 * wrapToolCall middleware: calls next(), inspects the response, and
 * truncates if the serialized output exceeds the configured byte limit.
 */

import type { KoiMiddleware } from "@koi/core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ResultPrunerConfig {
  /** Maximum byte length of serialized tool output. Default: 51200 (50 KB). */
  readonly maxOutputBytes: number;
}

const DEFAULT_CONFIG: ResultPrunerConfig = Object.freeze({
  maxOutputBytes: 51_200,
});

/**
 * Serialize a tool output to a string for size measurement.
 * Handles string passthrough; everything else gets JSON.stringify.
 */
function serialize(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Creates a middleware that truncates tool call results exceeding the
 * configured byte limit. The truncated output includes a suffix indicating
 * the original size so the model knows data was lost.
 */
export function createResultPruner(config?: Partial<ResultPrunerConfig>): KoiMiddleware {
  const { maxOutputBytes } = { ...DEFAULT_CONFIG, ...config };

  return {
    name: "koi:result-pruner",

    wrapToolCall: async (_ctx, request, next) => {
      const response = await next(request);

      const serialized = serialize(response.output);

      // Encode once — reused for both size check and truncation
      const encoded = encoder.encode(serialized);

      if (encoded.byteLength <= maxOutputBytes) {
        return response;
      }

      // Truncate to maxOutputBytes then append a suffix
      const suffix = `\n\n[truncated from ${encoded.byteLength} bytes to ${maxOutputBytes} bytes]`;
      const truncatedBytes = encoded.slice(0, maxOutputBytes);
      const truncated = decoder.decode(truncatedBytes) + suffix;

      return response.metadata !== undefined
        ? { output: truncated, metadata: response.metadata }
        : { output: truncated };
    },
  };
}
