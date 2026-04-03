/**
 * Pattern registry — resolves pattern names to ToolCallPattern instances.
 */

import type { ToolCallPattern } from "../types.js";
import { hermesPattern } from "./hermes.js";
import { jsonFencePattern } from "./json-fence.js";
import { llama31Pattern } from "./llama31.js";

/** Map of built-in pattern name to pattern instance. */
export const BUILTIN_PATTERNS: ReadonlyMap<string, ToolCallPattern> = new Map([
  ["hermes", hermesPattern],
  ["llama31", llama31Pattern],
  ["json-fence", jsonFencePattern],
]);

/**
 * Resolves a mixed array of pattern names and custom pattern objects
 * into concrete ToolCallPattern instances.
 *
 * @throws Error if an unknown pattern name is encountered.
 */
export function resolvePatterns(
  entries: readonly (string | ToolCallPattern)[],
): readonly ToolCallPattern[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") return entry;
    const pattern = BUILTIN_PATTERNS.get(entry);
    if (pattern === undefined) {
      throw new Error(
        `Unknown tool recovery pattern "${entry}". Valid: ${[...BUILTIN_PATTERNS.keys()].join(", ")}`,
      );
    }
    return pattern;
  });
}
