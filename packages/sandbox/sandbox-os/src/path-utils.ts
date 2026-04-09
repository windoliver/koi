/**
 * Shared path manipulation utilities for sandbox profile processing.
 * Used by both bwrap (Linux) and seatbelt (macOS) platform backends.
 */

/**
 * Strip a trailing glob suffix from a path, returning the base directory.
 *
 * @example
 * stripGlobSuffix("/home/user/project/*.ts") // → "/home/user/project"
 * stripGlobSuffix("/home/user/*")             // → "/home/user"
 * stripGlobSuffix("/home/user")               // → "/home/user" (unchanged)
 */
export function stripGlobSuffix(path: string): string {
  return path.replace(/\/?\*.*$/, "");
}

/**
 * Returns true if the path contains a glob pattern character (* ? []).
 * Used by validators to reject paths that would be silently mishandled
 * by platform backends (bwrap, seatbelt).
 */
export function hasGlobPattern(path: string): boolean {
  return path.includes("*") || path.includes("?") || path.includes("[");
}
