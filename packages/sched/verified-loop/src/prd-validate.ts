/**
 * Structural validators for individual PRD items.
 *
 * Hand-edited PRDs frequently contain bugs like `done: "false"` (truthy
 * string) which silently break `nextItem` — fail fast instead.
 */

/**
 * Validate one PRD item structurally. Returns undefined if valid, or a
 * human-readable issue description otherwise.
 */
export function validatePRDItem(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) {
    return `not an object`;
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return `'id' must be a non-empty string`;
  }
  if (typeof obj.description !== "string") {
    return `'description' must be a string`;
  }
  if (typeof obj.done !== "boolean") {
    return `'done' must be a boolean (got ${typeof obj.done})`;
  }
  if (obj.skipped !== undefined && typeof obj.skipped !== "boolean") {
    return `'skipped' must be a boolean if present`;
  }
  const numericIssue = validateNumericFields(obj);
  if (numericIssue !== undefined) return numericIssue;
  if (obj.verifiedAt !== undefined && typeof obj.verifiedAt !== "string") {
    return `'verifiedAt' must be a string if present`;
  }
  // done and skipped are mutually exclusive in the result contract — the
  // same id must never appear in both completed[] and skipped[]. A PRD that
  // persists this combination (hand edit, partial-write recovery, third
  // party) must fail fast rather than silently feed the loop contradictory
  // state that downstream reports cannot disambiguate.
  if (obj.done === true && obj.skipped === true) {
    return `'done' and 'skipped' cannot both be true`;
  }
  return undefined;
}

function validateNumericFields(obj: Record<string, unknown>): string | undefined {
  if (obj.priority !== undefined) {
    if (typeof obj.priority !== "number" || !Number.isFinite(obj.priority)) {
      return `'priority' must be a finite number if present`;
    }
  }
  if (obj.iterationCount !== undefined) {
    // Non-negative integer — counts can never be fractional or negative.
    // A hand-edited PRD with iterationCount: -5 would otherwise distort
    // every subsequent +1 and produce nonsensical history.
    if (
      typeof obj.iterationCount !== "number" ||
      !Number.isInteger(obj.iterationCount) ||
      obj.iterationCount < 0
    ) {
      return `'iterationCount' must be a non-negative integer if present`;
    }
  }
  if (obj.consecutiveFailureCount !== undefined) {
    // Same rationale as iterationCount: bumpFailureCount does
    // (count ?? 0) + 1 and compares to the skip threshold. Negative or
    // fractional persisted values would delay skipping or make the
    // budget behave unpredictably across restarts.
    if (
      typeof obj.consecutiveFailureCount !== "number" ||
      !Number.isInteger(obj.consecutiveFailureCount) ||
      obj.consecutiveFailureCount < 0
    ) {
      return `'consecutiveFailureCount' must be a non-negative integer if present`;
    }
  }
  return undefined;
}
