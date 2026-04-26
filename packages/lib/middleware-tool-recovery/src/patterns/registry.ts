/**
 * Pattern registry — resolves pattern name strings to `ToolCallPattern` instances.
 */

import type { ToolCallPattern } from "../types.js";
import { hermesPattern } from "./hermes.js";
import { jsonFencePattern } from "./json-fence.js";
import { llama31Pattern } from "./llama31.js";

/** Map of built-in pattern name to pattern instance. */
export const BUILTIN_PATTERNS: ReadonlyMap<string, ToolCallPattern> = new Map<
  string,
  ToolCallPattern
>([
  ["hermes", hermesPattern],
  ["llama31", llama31Pattern],
  ["json-fence", jsonFencePattern],
]);

/**
 * Resolves a mixed array of pattern name strings and custom `ToolCallPattern`
 * objects into concrete pattern instances.
 *
 * @throws Error when an unknown pattern name is encountered. Validation in
 *   `validateToolRecoveryConfig` should catch this earlier; the throw exists
 *   as a defense-in-depth check for callers that bypass validation.
 */
export function resolvePatterns(
  entries: readonly (string | ToolCallPattern)[],
): readonly ToolCallPattern[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") return entry;
    const pattern = BUILTIN_PATTERNS.get(entry);
    if (pattern === undefined) {
      throw new Error(
        `Unknown tool recovery pattern "${entry}". Valid: ${[...BUILTIN_PATTERNS.keys()].join(
          ", ",
        )}`,
      );
    }
    return pattern;
  });
}
