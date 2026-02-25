/**
 * Content scanning — scan strings, content blocks, messages, and tool output for PII.
 */

import type { ContentBlock, InboundMessage } from "@koi/core/message";
import { applyMatches } from "./apply-matches.js";
import type { PIIHasherFactory } from "./strategies.js";
import type { PIIDetector, PIIMatch, PIIStrategy } from "./types.js";

/** Result of scanning a string for PII. */
export interface ScanStringResult {
  readonly text: string;
  readonly matches: readonly PIIMatch[];
  readonly changed: boolean;
}

/** Result of scanning a content block. */
export interface ScanBlockResult {
  readonly block: ContentBlock;
  readonly matches: readonly PIIMatch[];
  readonly changed: boolean;
}

/** Result of scanning a full message. */
export interface ScanMessageResult {
  readonly message: InboundMessage;
  readonly matches: readonly PIIMatch[];
  readonly changed: boolean;
}

/** Result of scanning a JSON value (tool output). */
export interface ScanJsonResult {
  readonly value: unknown;
  readonly matches: readonly PIIMatch[];
  readonly changed: boolean;
}

const EMPTY_MATCHES: readonly PIIMatch[] = [];

/** Scan a single string for PII and apply the strategy. */
export function scanString(
  text: string,
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
): ScanStringResult {
  // Collect matches from all detectors
  const allMatches: PIIMatch[] = [];
  for (const detector of detectors) {
    const found = detector.detect(text);
    for (const match of found) {
      allMatches.push(match);
    }
  }

  if (allMatches.length === 0) {
    return { text, matches: EMPTY_MATCHES, changed: false };
  }

  const result = applyMatches(text, allMatches, strategy, createHasher);
  return { text: result.text, matches: result.matches, changed: true };
}

/** Scan a single content block for PII. Only processes text blocks. */
export function scanBlock(
  block: ContentBlock,
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
): ScanBlockResult {
  switch (block.kind) {
    case "text": {
      const result = scanString(block.text, detectors, strategy, createHasher);
      if (!result.changed) {
        return { block, matches: EMPTY_MATCHES, changed: false };
      }
      return {
        block: { ...block, text: result.text },
        matches: result.matches,
        changed: true,
      };
    }
    case "file":
    case "image":
    case "button":
    case "custom":
      return { block, matches: EMPTY_MATCHES, changed: false };
  }
}

/** Scan all content blocks in an InboundMessage. */
export function scanMessage(
  message: InboundMessage,
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
): ScanMessageResult {
  const allMatches: PIIMatch[] = [];
  // let justified: tracks whether any block was modified
  let anyChanged = false;

  const scannedContent = message.content.map((block) => {
    const result = scanBlock(block, detectors, strategy, createHasher);
    if (result.changed) {
      anyChanged = true;
      for (const match of result.matches) {
        allMatches.push(match);
      }
    }
    return result.block;
  });

  if (!anyChanged) {
    return { message, matches: EMPTY_MATCHES, changed: false };
  }

  return {
    message: { ...message, content: scannedContent },
    matches: allMatches,
    changed: true,
  };
}

/** Default maximum recursion depth for JSON walking. */
const DEFAULT_MAX_DEPTH = 10;

/** Recursively scan a JSON value for PII in all string leaves. */
export function scanJson(
  value: unknown,
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): ScanJsonResult {
  return walkJson(value, detectors, strategy, createHasher, maxDepth, 0);
}

function walkJson(
  value: unknown,
  detectors: readonly PIIDetector[],
  strategy: PIIStrategy,
  createHasher: PIIHasherFactory | undefined,
  maxDepth: number,
  depth: number,
): ScanJsonResult {
  if (depth > maxDepth) {
    return { value, matches: EMPTY_MATCHES, changed: false };
  }

  if (typeof value === "string") {
    const result = scanString(value, detectors, strategy, createHasher);
    return { value: result.text, matches: result.matches, changed: result.changed };
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return { value, matches: EMPTY_MATCHES, changed: false };
  }

  if (Array.isArray(value)) {
    const allMatches: PIIMatch[] = [];
    // let justified: tracks whether any element was modified
    let anyChanged = false;

    const newArr = value.map((item: unknown) => {
      const result = walkJson(item, detectors, strategy, createHasher, maxDepth, depth + 1);
      if (result.changed) {
        anyChanged = true;
        for (const match of result.matches) {
          allMatches.push(match);
        }
      }
      return result.value;
    });

    return { value: anyChanged ? newArr : value, matches: allMatches, changed: anyChanged };
  }

  // Object — recurse values
  // Cast justified: value is non-null, non-array object after guards above.
  const obj: Record<string, unknown> = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const allMatches: PIIMatch[] = [];
  // let justified: tracks whether any field was modified
  let anyChanged = false;
  const entries: Array<readonly [string, unknown]> = [];

  for (const key of keys) {
    const result = walkJson(obj[key], detectors, strategy, createHasher, maxDepth, depth + 1);
    if (result.changed) {
      anyChanged = true;
      for (const match of result.matches) {
        allMatches.push(match);
      }
    }
    entries.push([key, result.value] as const);
  }

  if (!anyChanged) {
    return { value, matches: allMatches, changed: false };
  }

  const newObj: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    newObj[key] = val;
  }
  return { value: newObj, matches: allMatches, changed: true };
}
