/**
 * Sliding window buffer for PII detection in streaming output.
 *
 * Text chunks are appended to an internal buffer. The buffer is scanned
 * for PII, and confirmed-safe prefix text (everything before the danger
 * zone) is yielded. On flush, all remaining content is scanned and returned.
 *
 * Block strategy is downgraded to redact in streaming mode — we can't
 * retract already-yielded content.
 */

import { scanString } from "./scan.js";
import type { PIIHasherFactory } from "./strategies.js";
import type { PIIDetector, PIIMatch, PIIStrategy } from "./types.js";

/** Default sliding window buffer size in characters. */
const DEFAULT_BUFFER_SIZE = 64;

/** Result from push() or flush(). */
export interface PIIStreamBufferResult {
  readonly safe: string;
  readonly matches: readonly PIIMatch[];
}

/** Pre-allocated singleton for the common buffering case. */
const EMPTY_RESULT: PIIStreamBufferResult = { safe: "", matches: [] } as const;

/** Stream buffer interface for PII scanning. */
export interface PIIStreamBuffer {
  readonly push: (text: string) => PIIStreamBufferResult;
  readonly flush: () => PIIStreamBufferResult;
}

/**
 * Create a sliding window stream buffer for PII detection in streaming output.
 * Block strategy is downgraded to redact (can't un-yield sent chunks).
 */
export function createPIIStreamBuffer(
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
  bufferSize: number = DEFAULT_BUFFER_SIZE,
): PIIStreamBuffer {
  // Downgrade block to redact for streaming
  const effectiveStrategy: PIIStrategy = strategy === "block" ? "redact" : strategy;

  // let justified: mutable internal buffer accumulating streaming text
  let buffer = "";

  function push(text: string): PIIStreamBufferResult {
    buffer += text;

    if (buffer.length <= bufferSize) {
      return EMPTY_RESULT;
    }

    // The last bufferSize chars might contain a split PII pattern — keep them buffered
    const safeEnd = buffer.length - bufferSize;
    const safeChunk = buffer.slice(0, safeEnd);
    buffer = buffer.slice(safeEnd);

    const result = scanString(safeChunk, detectors, effectiveStrategy, createHasher);
    return { safe: result.text, matches: result.matches };
  }

  function flush(): PIIStreamBufferResult {
    if (buffer.length === 0) {
      return EMPTY_RESULT;
    }

    const remaining = buffer;
    buffer = "";

    const result = scanString(remaining, detectors, effectiveStrategy, createHasher);
    return { safe: result.text, matches: result.matches };
  }

  return { push, flush };
}
