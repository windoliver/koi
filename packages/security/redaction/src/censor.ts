/**
 * Censor strategies — pure functions for replacing detected secrets.
 */

import type { Censor, CensorStrategy, SecretMatch } from "./types.js";

/** Redact: replace with `[REDACTED]`. */
function applyRedact(_match: SecretMatch): string {
  return "[REDACTED]";
}

/** Mask: first 4 chars + `***` (preserves some info for debugging). */
function applyMask(match: SecretMatch): string {
  if (match.text.length <= 4) return "***";
  return `${match.text.slice(0, 4)}***`;
}

/** Remove: strip entirely. */
function applyRemove(_match: SecretMatch): string {
  return "";
}

/** Dispatch a named strategy to its implementation. */
function applyStrategy(match: SecretMatch, strategy: CensorStrategy): string {
  switch (strategy) {
    case "redact":
      return applyRedact(match);
    case "mask":
      return applyMask(match);
    case "remove":
      return applyRemove(match);
  }
}

/** Apply a censor (strategy name or custom function) to a match. */
export function applyCensor(match: SecretMatch, censor: Censor, fieldName?: string): string {
  if (typeof censor === "function") {
    return censor(match, fieldName);
  }
  return applyStrategy(match, censor);
}

/** Apply a censor to an entire field value (field-name match). */
export function applyCensorToField(value: string, censor: Censor, fieldName: string): string {
  const syntheticMatch: SecretMatch = {
    text: value,
    start: 0,
    end: value.length,
    kind: "field",
  };
  return applyCensor(syntheticMatch, censor, fieldName);
}
