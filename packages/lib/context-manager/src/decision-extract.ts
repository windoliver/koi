/**
 * Decision signal extraction — scans messages for decision-relevant content.
 *
 * Used by the pre-compaction pipeline to extract decision facts from messages
 * about to be dropped, preserving them before they are permanently lost.
 *
 * The extractor uses configurable RegExp patterns and metadata keys to
 * identify decision signals. Default patterns cover common decision language
 * (approvals, pricing, constraints, preferences, rationale).
 */

import type { InboundMessage, JsonObject } from "@koi/core";
import type { DecisionSignal, DecisionSignalKind } from "@koi/core/rich-trajectory";

// ---------------------------------------------------------------------------
// Default patterns — common decision language
// ---------------------------------------------------------------------------

interface PatternEntry {
  readonly kind: DecisionSignalKind;
  readonly pattern: RegExp;
}

const DEFAULT_PATTERNS: readonly PatternEntry[] = [
  {
    kind: "approval",
    pattern: /\b(?:approved|confirmed|agreed|accepted|authorized|signed.?off)\b/i,
  },
  {
    kind: "pricing",
    pattern: /\b(?:price[ds]?\b|pricing|cost|budget|rate|fee|discount|invoice)\b/i,
  },
  {
    kind: "constraint",
    pattern: /\b(?:must\s+not|must\b|require[ds]?\b|mandatory|shall\b|forbidden)\b/i,
  },
  { kind: "preference", pattern: /\b(?:prefer[rs]?|rather|instead|opt(?:ed|ing)?\s+for)\b/i },
  {
    kind: "rationale",
    pattern: /\b(?:because|reason|rationale|justification|due\s+to|in\s+order\s+to)\b/i,
  },
] as const;

/** Default metadata keys that mark a message as decision-relevant. */
const DEFAULT_METADATA_KEYS: readonly string[] = [
  "decision",
  "approval",
  "approved",
  "constraint",
  "rationale",
] as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the decision signal extractor. */
export interface DecisionSignalExtractorConfig {
  /**
   * Additional patterns to match against message text content.
   * Each entry maps a pattern to a decision signal kind.
   * These are checked in addition to the default patterns.
   */
  readonly patterns?: readonly { readonly kind: DecisionSignalKind; readonly pattern: RegExp }[];
  /**
   * Additional metadata keys that mark a message as decision-relevant.
   * If a message's metadata contains any of these keys, a signal is extracted.
   * These are checked in addition to the default metadata keys.
   */
  readonly metadataKeys?: readonly string[];
  /**
   * When true, skip the default patterns and only use the provided ones.
   * @default false
   */
  readonly skipDefaults?: boolean;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the text content from a message's content blocks.
 */
function extractText(message: InboundMessage): string {
  const parts: string[] = []; // let: accumulator built once
  for (const block of message.content) {
    if (block.kind === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract decision signals from messages about to be dropped by compaction.
 *
 * Scans each message for decision-relevant content using:
 * 1. RegExp pattern matching against text content
 * 2. Metadata key presence checks
 *
 * Returns one signal per matched pattern/key per message (a message may
 * produce multiple signals if it matches multiple patterns).
 *
 * @param messages — Messages about to be dropped (from `droppedMessages`).
 * @param messageIndexOffset — Index offset for `sourceMessageIndex` (the
 *   index of the first dropped message in the original conversation array).
 *   Defaults to 0 if dropped messages start at index 0.
 * @param config — Optional extraction configuration.
 */
export function extractDecisionSignals(
  messages: readonly InboundMessage[],
  messageIndexOffset = 0,
  config?: DecisionSignalExtractorConfig,
): readonly DecisionSignal[] {
  const patterns =
    config?.skipDefaults === true
      ? (config.patterns ?? [])
      : [...DEFAULT_PATTERNS, ...(config?.patterns ?? [])];

  const metadataKeys =
    config?.skipDefaults === true
      ? (config?.metadataKeys ?? [])
      : [...DEFAULT_METADATA_KEYS, ...(config?.metadataKeys ?? [])];

  const now = Date.now();
  const signals: DecisionSignal[] = []; // let: accumulator built once

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;

    const text = extractText(message);
    const sourceMessageIndex = messageIndexOffset + i;
    const seen = new Set<DecisionSignalKind>(); // let: dedup per-message

    // Pattern matching against text content
    if (text.length > 0) {
      for (const entry of patterns) {
        // Reset lastIndex to handle stateful /g and /y regexes safely
        entry.pattern.lastIndex = 0;
        if (!seen.has(entry.kind) && entry.pattern.test(text)) {
          seen.add(entry.kind);
          // Extract a short summary: the sentence containing the match
          entry.pattern.lastIndex = 0;
          const match = entry.pattern.exec(text);
          const summary = match !== null ? extractSentence(text, match.index) : text.slice(0, 200);

          signals.push({
            kind: entry.kind,
            summary,
            sourceMessageIndex,
            timestamp: message.timestamp ?? now,
          });
        }
      }
    }

    // Metadata key presence checks
    if (message.metadata !== undefined) {
      for (const key of metadataKeys) {
        if (key in message.metadata && !seen.has("custom")) {
          const value = message.metadata[key];
          const summary =
            typeof value === "string" ? value.slice(0, 200) : `metadata.${key} present`;
          signals.push({
            kind: "custom",
            summary,
            sourceMessageIndex,
            timestamp: message.timestamp ?? now,
            metadata: { key } satisfies JsonObject,
          });
          // Only one custom signal per metadata scan to avoid noise
          break;
        }
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the sentence surrounding a match index in a text.
 * Returns up to 200 characters of context.
 */
function extractSentence(text: string, matchIndex: number): string {
  // Find sentence boundaries (period, newline, or string boundary)
  const sentenceStart = Math.max(
    0,
    text.lastIndexOf(".", Math.max(0, matchIndex - 1)) + 1,
    text.lastIndexOf("\n", Math.max(0, matchIndex - 1)) + 1,
  );
  const sentenceEnd = Math.min(
    text.length,
    Math.min(
      text.indexOf(".", matchIndex) !== -1 ? text.indexOf(".", matchIndex) + 1 : text.length,
      text.indexOf("\n", matchIndex) !== -1 ? text.indexOf("\n", matchIndex) : text.length,
    ),
  );

  const sentence = text.slice(sentenceStart, sentenceEnd).trim();
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}
