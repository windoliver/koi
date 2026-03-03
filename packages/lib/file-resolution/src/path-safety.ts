/**
 * Path segment validation for safe file path construction.
 *
 * Prevents path traversal and special character injection when
 * building file paths from user-controlled segments (agent names, file names).
 */

/**
 * Allowlist regex: starts with alphanumeric, followed by alphanumeric, dots, underscores, or hyphens.
 * Rejects: empty strings, leading dots (.hidden, .., .), slashes, null bytes, spaces, etc.
 */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** POSIX NAME_MAX — maximum length for a single path segment. */
const MAX_SEGMENT_LENGTH = 255;

/**
 * Returns true if the segment is safe to use in path construction.
 * Validates against traversal attacks (../, ..), hidden files (.hidden),
 * special characters (slashes, null bytes, spaces), and excessive length.
 */
export function isValidPathSegment(segment: string): boolean {
  return segment.length <= MAX_SEGMENT_LENGTH && SAFE_PATH_SEGMENT.test(segment);
}
