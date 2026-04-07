/**
 * Compute a unified diff string from an edit hunk (old_string -> new_string).
 *
 * The inputs are already isolated changes (not full files), so we format them
 * directly as a unified diff rather than computing an LCS-based diff.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a string into lines, preserving the final empty entry only when the
 * string ends with a newline (so we can count lines accurately).
 */
function splitLines(str: string): readonly string[] {
  if (str === "") return [];
  // Split and drop the trailing empty element that results from a final "\n"
  const parts = str.split("\n");
  if (parts[parts.length - 1] === "") {
    return parts.slice(0, -1);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a unified diff string from an edit hunk (old_string -> new_string).
 *
 * The inputs are already isolated changes (not full files), so we format them
 * directly as a unified diff rather than computing an LCS-based diff.
 */
export function computeEditDiff(oldStr: string, newStr: string, filename?: string): string {
  const name = filename ?? "file";
  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);

  // Both empty -> no diff
  if (oldLines.length === 0 && newLines.length === 0) return "";

  const header = `--- a/${name}\n+++ b/${name}`;
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const oldStart = oldCount === 0 ? 0 : 1;
  const newStart = newCount === 0 ? 0 : 1;
  const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

  const removals = oldLines.map((line) => `-${line}`);
  const additions = newLines.map((line) => `+${line}`);

  return [header, hunkHeader, ...removals, ...additions].join("\n");
}
