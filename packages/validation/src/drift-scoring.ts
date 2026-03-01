/**
 * Drift scoring — measures how much a brick's source files have changed.
 *
 * Pure function: takes glob patterns (from BrickDriftContext.sourceFiles)
 * and a list of changed files, returns a 0–1 score representing the
 * proportion of source patterns with changes.
 */

// ---------------------------------------------------------------------------
// Glob-to-regex conversion (simple, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a RegExp. Supports:
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/` (directory traversal)
 * - `?` matches a single non-`/` character
 * - Literal characters are escaped for regex safety
 */
function globToRegex(pattern: string): RegExp {
  let result = "^";
  let i = 0; // let: index incremented through pattern characters
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match anything including path separators
        // Skip optional trailing `/` after `**`
        i += 2;
        if (pattern[i] === "/") i++;
        result += ".*";
      } else {
        // `*` — match anything except `/`
        result += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      result += "[^/]";
      i++;
    } else {
      // Escape regex special characters
      result += char !== undefined ? char.replace(/[.+^${}()|[\]\\]/g, "\\$&") : "";
      i++;
    }
  }
  result += "$";
  return new RegExp(result);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the drift score for a brick's source file patterns.
 *
 * @param sourcePatterns - Glob patterns of codebase files the brick describes.
 * @param changedFiles - Files that have changed since the brick was last checked.
 * @returns 0–1 score: proportion of source patterns that have matching changes.
 *   Returns 0 if either input is empty.
 */
export function computeDrift(
  sourcePatterns: readonly string[],
  changedFiles: readonly string[],
): number {
  if (sourcePatterns.length === 0 || changedFiles.length === 0) {
    return 0;
  }

  let patternsWithChanges = 0; // let: counter incremented per matching pattern
  for (const pattern of sourcePatterns) {
    const regex = globToRegex(pattern);
    const hasMatch = changedFiles.some((file) => regex.test(file));
    if (hasMatch) {
      patternsWithChanges++;
    }
  }

  return patternsWithChanges / sourcePatterns.length;
}
