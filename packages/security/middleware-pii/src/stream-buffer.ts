/**
 * Sliding window buffer for PII detection in streaming output.
 *
 * Text chunks are appended to an internal buffer. The buffer is scanned
 * for PII, and confirmed-safe prefix text (everything before the danger
 * zone) is yielded. On flush, all remaining content is scanned and returned.
 *
 * Block strategy is downgraded to redact in streaming mode — we can't
 * retract already-yielded content. The caller is responsible for logging
 * a warning once; the buffer only fires the onStrategyDowngrade callback.
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

/** Callback invoked when block strategy is downgraded to redact in streaming mode. */
export type StrategyDowngradeCallback = (original: PIIStrategy, effective: PIIStrategy) => void;

/**
 * Create a sliding window stream buffer for PII detection in streaming output.
 * Block strategy is downgraded to redact (can't un-yield sent chunks).
 */
export function createPIIStreamBuffer(
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
  bufferSize: number = DEFAULT_BUFFER_SIZE,
  onStrategyDowngrade?: StrategyDowngradeCallback,
): PIIStreamBuffer {
  // Downgrade block to redact for streaming
  const effectiveStrategy: PIIStrategy = strategy === "block" ? "redact" : strategy;

  if (strategy === "block") {
    onStrategyDowngrade?.(strategy, effectiveStrategy);
  }

  // Array-based buffer: avoids per-chunk string concatenation on immutable strings
  const parts: string[] = [];
  // let justified: tracks total character count across accumulated parts
  let totalLength = 0;

  function push(text: string): PIIStreamBufferResult {
    parts.push(text);
    totalLength += text.length;

    if (totalLength <= bufferSize) {
      return EMPTY_RESULT;
    }

    const buffer = parts.join("");
    const safeEnd = buffer.length - bufferSize;
    const safeChunk = buffer.slice(0, safeEnd);

    // Reset to just the tail
    const tail = buffer.slice(safeEnd);
    parts.length = 0;
    parts.push(tail);
    totalLength = tail.length;

    const result = scanString(safeChunk, detectors, effectiveStrategy, createHasher);
    return { safe: result.text, matches: result.matches };
  }

  function flush(): PIIStreamBufferResult {
    if (totalLength === 0) {
      return EMPTY_RESULT;
    }

    const remaining = parts.join("");
    parts.length = 0;
    totalLength = 0;

    const result = scanString(remaining, detectors, effectiveStrategy, createHasher);
    return { safe: result.text, matches: result.matches };
  }

  return { push, flush };
}
