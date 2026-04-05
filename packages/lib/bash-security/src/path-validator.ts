import { resolve } from "node:path";
import { matchPatterns } from "./match.js";
import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Path traversal patterns — compiled once at module load.
 * Covers raw traversal, URL-encoded variants, double encoding, and null bytes.
 */
const PATH_TRAVERSAL_PATTERNS: readonly ThreatPattern[] = [
  {
    // Raw directory traversal: ../ or ..\ or bare .. at end of path
    regex: /\.\.(\/|\\|$)/,
    category: "path-traversal",
    reason: "Directory traversal sequence detected (../)",
  },
  {
    // Single URL-encoded: %2e%2e (case-insensitive)
    regex: /%2e%2e/i,
    category: "path-traversal",
    reason: "URL-encoded directory traversal detected (%2e%2e)",
  },
  {
    // Double URL-encoded: %252e%252e
    regex: /%252e%252e/i,
    category: "path-traversal",
    reason: "Double URL-encoded directory traversal detected (%252e%252e)",
  },
  {
    // Null byte injection in paths
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — security pattern detects null byte injection
    regex: /\u0000/,
    category: "path-traversal",
    reason: "Null byte in path can bypass security checks",
  },
] as const;

/**
 * Non-printable characters (control codes) that should never appear in paths.
 * Excludes \u0000 (covered above) and standard whitespace (\u0009 tab, \u000a LF, \u000d CR).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — security pattern detects non-printable control characters in paths
const NON_PRINTABLE = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Validate a filesystem path string against traversal sequences, encoding
 * bypasses, null bytes, and non-printable characters.
 *
 * When `baseDir` is provided, the path is resolved (canonicalized) and must
 * remain under that base directory — symlink traversal and `../` sequences
 * that resolve outside are rejected.
 *
 * @param path - The path string to validate.
 * @param baseDir - If provided, the canonicalized path must be a descendant.
 */
export function validatePath(path: string, baseDir?: string): ClassificationResult {
  // 1. Pattern checks on the raw string (catches encoded variants before decode)
  const patternResult = matchPatterns(path, PATH_TRAVERSAL_PATTERNS);
  if (!patternResult.ok) return patternResult;

  // 2. Non-printable character check (broad set not covered by regex patterns)
  if (NON_PRINTABLE.test(path)) {
    return {
      ok: false,
      reason: "Non-printable control characters in path are disallowed",
      pattern: NON_PRINTABLE.source,
      category: "path-traversal",
    };
  }

  // 3. Canonicalize and base-directory containment check
  if (baseDir !== undefined) {
    const canonicalBase = resolve(baseDir);
    const canonicalPath = resolve(baseDir, path);
    // Must be exactly the base or a descendant (with trailing slash to prevent prefix collision)
    const isContained =
      canonicalPath === canonicalBase || canonicalPath.startsWith(`${canonicalBase}/`);
    if (!isContained) {
      return {
        ok: false,
        reason: `Path resolves outside the allowed base directory (${canonicalBase})`,
        pattern: canonicalPath,
        category: "path-traversal",
      };
    }
  }

  return { ok: true };
}
