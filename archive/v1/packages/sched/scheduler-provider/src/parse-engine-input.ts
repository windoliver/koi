/**
 * Parse a raw string into an EngineInput.
 *
 * If the string is valid JSON with a recognised `kind` field it is used
 * as-is (structured EngineInput). Otherwise the whole string is wrapped
 * in a `{ kind: "text", text }` envelope.
 */

import type { EngineInput } from "@koi/core";

const ENGINE_INPUT_KINDS = new Set([
  "text",
  "messages",
  "resume",
] as const satisfies readonly EngineInput["kind"][]);

/**
 * Type guard: returns `true` when `value` is a non-null object whose
 * `kind` field matches a recognised EngineInput discriminator.
 */
function isEngineInputLike(value: unknown): value is EngineInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.kind === "string" &&
    ENGINE_INPUT_KINDS.has(candidate.kind as EngineInput["kind"])
  );
}

/**
 * Convert a raw input string to an `EngineInput`.
 *
 * 1. Attempt `JSON.parse` — if it succeeds *and* the result looks like a
 *    structured `EngineInput` (has a valid `kind`), return it directly.
 * 2. Otherwise wrap the original string as plain text.
 */
export function parseEngineInput(raw: string): EngineInput {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isEngineInputLike(parsed)) {
      return parsed;
    }
  } catch (_e: unknown) {
    /* not JSON — fall through to text wrapping */
  }
  return { kind: "text" as const, text: raw };
}
