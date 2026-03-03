/**
 * Resource pattern parsing — extracts tool name and resource path from
 * delegation resource patterns like "read_file:/workspace/src/**".
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed resource pattern with tool name and resource path. */
export interface ResourcePattern {
  readonly tool: string;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a resource pattern string into tool and path components.
 *
 * Pattern format: `"<tool>:<path>"` — the first colon separates tool from path.
 * Returns undefined if the pattern contains no colon.
 *
 * @example
 * parseResourcePattern("read_file:/src/main.ts") // { tool: "read_file", path: "/src/main.ts" }
 * parseResourcePattern("no_colon")               // undefined
 */
export function parseResourcePattern(pattern: string): ResourcePattern | undefined {
  const colonIndex = pattern.indexOf(":");
  if (colonIndex < 0) return undefined;
  return { tool: pattern.slice(0, colonIndex), path: pattern.slice(colonIndex + 1) };
}
