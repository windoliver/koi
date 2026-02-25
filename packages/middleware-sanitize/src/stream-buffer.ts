/**
 * Sliding window buffer for streaming output sanitization.
 *
 * Text chunks are appended to an internal buffer. The buffer is scanned
 * for patterns, and confirmed-safe prefix text (everything before the
 * danger zone of `bufferSize` chars) is yielded. On flush, all remaining
 * buffered content is sanitized and returned.
 */

import type { SanitizationEvent, SanitizeRule } from "./types.js";

/** Default sliding window buffer size in characters. */
const DEFAULT_BUFFER_SIZE = 256;

/** Result from push() or flush(). */
export interface StreamBufferResult {
  readonly safe: string;
  readonly events: readonly SanitizationEvent[];
}

/** Pre-allocated singleton for the common buffering case (nothing to yield yet). */
const EMPTY_RESULT: StreamBufferResult = { safe: "", events: [] } as const;

/** Stream buffer interface returned by createStreamBuffer(). */
export interface StreamBuffer {
  /** Append text to the buffer, returning confirmed-safe prefix content. */
  readonly push: (text: string) => StreamBufferResult;
  /** Flush all remaining buffered content through sanitization. */
  readonly flush: () => StreamBufferResult;
}

/**
 * Downgrade `block` actions to `strip` for streaming context.
 * Call once at factory creation, pass the result to `createStreamBuffer`.
 */
export function mapBlockToStrip(rules: readonly SanitizeRule[]): readonly SanitizeRule[] {
  return rules.map((rule) => {
    if (rule.action.kind === "block") {
      return { ...rule, action: { kind: "strip" as const, replacement: "" } };
    }
    return rule;
  });
}

/**
 * Create a sliding window stream buffer for sanitizing streaming output.
 *
 * Expects rules pre-processed via `mapBlockToStrip` — block actions should
 * already be downgraded to strip (since we can't retract already-yielded content).
 */
export function createStreamBuffer(
  rules: readonly SanitizeRule[],
  bufferSize: number = DEFAULT_BUFFER_SIZE,
): StreamBuffer {
  // let justified: mutable internal buffer accumulating streaming text
  let buffer = "";

  function applyRules(text: string): {
    readonly sanitized: string;
    readonly events: readonly SanitizationEvent[];
  } {
    const events: SanitizationEvent[] = [];
    // let justified: accumulates sanitized text through rule passes
    let current = text;

    for (const rule of rules) {
      if (!rule.pattern.test(current)) {
        continue;
      }

      const original = current;
      const replacement =
        rule.action.kind === "strip" || rule.action.kind === "flag" ? rule.action.replacement : "";
      current = current.replace(rule.pattern, replacement);

      events.push({
        rule,
        original,
        sanitized: current,
        location: "output",
      });
    }

    return { sanitized: current, events };
  }

  function push(text: string): StreamBufferResult {
    buffer += text;

    // If buffer is shorter than the window, nothing is safe to yield yet
    if (buffer.length <= bufferSize) {
      return EMPTY_RESULT;
    }

    // The last bufferSize chars might contain a split pattern — keep them buffered
    const safeEnd = buffer.length - bufferSize;
    const safeChunk = buffer.slice(0, safeEnd);
    buffer = buffer.slice(safeEnd);

    // Sanitize the safe chunk
    const { sanitized, events } = applyRules(safeChunk);
    return { safe: sanitized, events };
  }

  function flush(): StreamBufferResult {
    if (buffer.length === 0) {
      return EMPTY_RESULT;
    }

    const remaining = buffer;
    buffer = "";

    const { sanitized, events } = applyRules(remaining);
    return { safe: sanitized, events };
  }

  return { push, flush };
}
