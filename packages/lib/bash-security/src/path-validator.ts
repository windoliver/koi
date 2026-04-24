import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
 * Result of canonicalization — either a resolved path, or a dangling-symlink
 * rejection signal. Dangling symlinks represent a TOCTOU hazard: their target
 * may be created/swapped-in between validation and use, so they must not be
 * treated as "missing leaf" for containment purposes.
 */
type CanonicalResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "dangling-symlink"; readonly component: string };

/**
 * Canonicalize a path by realpath'ing the longest existing prefix, then
 * appending the non-existent remainder verbatim. Reject dangling symlinks
 * (where the symlink exists but its target does not) — a later write could
 * race with the attacker materializing the outside target.
 *
 * Why we walk: `realpathSync` throws ENOENT when any path component is
 * missing. A naive fallback to `resolve()` does NOT follow symlinks, which
 * would let an attacker plant `workspace/evil → /etc` and write to
 * `workspace/evil/new-file`.
 */
function canonicalizeExisting(p: string): CanonicalResult {
  const absolute = resolve(p);
  const suffix: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const real = realpathSync(cursor);
      return {
        ok: true,
        path: suffix.length === 0 ? real : join(real, ...suffix),
      };
    } catch {
      // realpathSync failed — either the component is genuinely missing, or
      // it's a dangling symlink. lstat can distinguish: a dangling symlink
      // returns a symlink stat, while a missing component throws.
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          return { ok: false, reason: "dangling-symlink", component: cursor };
        }
      } catch {
        // Not a symlink and doesn't exist — treat as missing, walk up.
      }
      const parent = dirname(cursor);
      if (parent === cursor) return { ok: true, path: absolute };
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Validate a filesystem path string against traversal sequences, encoding
 * bypasses, null bytes, and non-printable characters.
 *
 * When `baseDir` is provided, the path is resolved (canonicalized) and must
 * remain under that base directory — symlink traversal and `../` sequences
 * that resolve outside are rejected.
 *
 * **TOCTOU caveat**: this is a point-in-time containment check, not an atomic
 * gate on subsequent filesystem use. A path whose intermediate components do
 * not yet exist is validated by string-comparing the prefix; if an attacker
 * materializes a symlink at that location between validation and the actual
 * open/write, the write can escape the base. Callers writing files at a
 * validated path MUST either:
 *   - Re-validate immediately before the write, or
 *   - Open via `O_NOFOLLOW`/`openat` with no-follow per component, or
 *   - Create intermediate directories themselves (mkdir -p) before the check
 *     so realpathSync sees the full existing prefix.
 * Dangling symlinks — a symlink whose target does not exist yet — are
 * already rejected outright to close the most obvious race, but no
 * point-in-time validator can guarantee containment for a later write.
 *
 * @param path - The path string to validate.
 * @param baseDir - If provided, the canonicalized path must be a descendant.
 */
export function validatePath(path: string, baseDir?: string): ClassificationResult {
  // 1. Pattern checks on the raw string (catches encoded variants before decode).
  //    Path strings can legitimately contain `\` (on Windows paths) so we do
  //    NOT apply the shell-command normalizer here — it would strip backslashes
  //    and erase the `..\\` traversal signal.
  const patternResult = matchPatterns(path, PATH_TRAVERSAL_PATTERNS, { normalize: false });
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

  // 3. Symlink-safe canonicalization and base-directory containment check.
  //    Both sides go through the same walk — realpath the longest existing
  //    prefix, append the non-existent remainder — so string comparison is
  //    apples-to-apples even for leaves that don't exist yet. Dangling
  //    symlinks are rejected explicitly to close the TOCTOU gap where an
  //    attacker materializes an outside target between validation and use.
  if (baseDir !== undefined) {
    const baseResult = canonicalizeExisting(baseDir);
    const pathResult = canonicalizeExisting(resolve(baseDir, path));
    if (!baseResult.ok) {
      return {
        ok: false,
        reason: `Base directory contains a dangling symlink (${baseResult.component})`,
        pattern: baseResult.component,
        category: "path-traversal",
      };
    }
    if (!pathResult.ok) {
      return {
        ok: false,
        reason: `Path contains a dangling symlink (${pathResult.component}); its target may race an outside file`,
        pattern: pathResult.component,
        category: "path-traversal",
      };
    }
    const canonicalBase = baseResult.path;
    const canonicalPath = pathResult.path;
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
