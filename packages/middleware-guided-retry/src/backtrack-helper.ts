/**
 * Pure functions for storing/extracting BacktrackReason in AgentSnapshot metadata.
 */

import type { BacktrackReason } from "@koi/core";
import { BACKTRACK_REASON_KEY } from "@koi/core";

/**
 * Creates a new metadata object with the backtrack reason attached.
 * Does NOT mutate the original metadata -- returns a new object.
 */
export function attachBacktrackReason(
  metadata: Readonly<Record<string, unknown>>,
  reason: BacktrackReason,
): Readonly<Record<string, unknown>> {
  return { ...metadata, [BACKTRACK_REASON_KEY]: reason };
}

/**
 * Extracts a BacktrackReason from snapshot metadata, if present.
 * Returns undefined if the key is not set or the value doesn't match the expected shape.
 */
export function extractBacktrackReason(
  metadata: Readonly<Record<string, unknown>>,
): BacktrackReason | undefined {
  const value = metadata[BACKTRACK_REASON_KEY];
  if (!isBacktrackReason(value)) return undefined;
  return value;
}

/** Type guard that validates the structural shape of a BacktrackReason. */
function isBacktrackReason(value: unknown): value is BacktrackReason {
  if (value === null || value === undefined || typeof value !== "object") return false;
  if (!("kind" in value) || !("message" in value) || !("timestamp" in value)) return false;
  // After `in` checks, TypeScript knows these properties exist on the object.
  // Access via indexed type to avoid `as Type` assertion.
  const rec: Readonly<Record<string, unknown>> = value satisfies object;
  return (
    typeof rec.kind === "string" &&
    typeof rec.message === "string" &&
    typeof rec.timestamp === "number"
  );
}
