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
 * Result of canonicalization — either a resolved path, or a rejection signal.
 * Dangling symlinks and missing intermediates both represent TOCTOU hazards:
 * their target (or an intermediate directory) may be created/swapped-in
 * between validation and use, so they must not be treated as safe.
 */
type CanonicalResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "dangling-symlink"; readonly component: string }
  | { readonly ok: false; readonly reason: "missing-intermediate"; readonly component: string };

/**
 * Canonicalize a path by realpath'ing the existing prefix. At most the final
 * path component (the leaf) may be missing; every intermediate directory must
 * already exist. Reject dangling symlinks and any form where more than the
 * leaf is absent, because a concurrent actor could materialize an attacker-
 * controlled symlink at a missing intermediate between validation and the
 * subsequent open/write.
 *
 * Why we walk at all instead of just realpath: `realpathSync` throws ENOENT
 * when any component is missing, including the leaf. Callers legitimately
 * validate the path of a file they are about to create, so we allow the
 * single leaf to be absent — but no deeper.
 */
function canonicalizeExisting(p: string): CanonicalResult {
  const absolute = resolve(p);
  try {
    const real = realpathSync(absolute);
    return { ok: true, path: real };
  } catch {
    // Leaf missing or dangling. Distinguish: if the leaf is a symlink whose
    // target does not exist, that is a dangling-symlink rejection.
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: "dangling-symlink", component: absolute };
      }
    } catch {
      // Leaf does not exist at all — fall through to parent check.
    }
  }
  // Leaf is absent and not a symlink. Parent MUST exist and realpath cleanly.
  const parent = dirname(absolute);
  if (parent === absolute) return { ok: true, path: absolute };
  try {
    const realParent = realpathSync(parent);
    return { ok: true, path: join(realParent, basename(absolute)) };
  } catch {
    // Parent missing — either a dangling-symlink parent or a missing
    // intermediate directory. Both are unsafe: a concurrent actor could
    // create `parent` as a symlink to an outside target before the caller
    // creates the leaf.
    try {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: "dangling-symlink", component: parent };
      }
    } catch {
      // Not a symlink and doesn't exist — treat as missing intermediate.
    }
    return { ok: false, reason: "missing-intermediate", component: parent };
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
 * **Strict containment**: only the final leaf component may be missing. Every
 * intermediate directory must exist and realpath cleanly inside the base; if
 * it does not, the call is rejected. This closes the race where a concurrent
 * actor materializes an attacker-controlled symlink at a missing intermediate
 * directory between validation and the subsequent open/write. Callers writing
 * files at a validated path must `mkdir -p` the parent directory before
 * calling, so only the leaf can be absent.
 *
 * **Residual TOCTOU**: even with strict intermediates, the leaf is still
 * subject to a narrower race — the parent directory itself could be swapped
 * between validation and open. Callers that need atomicity should either
 * re-validate immediately before the write, or open via `O_NOFOLLOW`/`openat`
 * with no-follow per component.
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
  //    Both sides go through the same walk — realpath the existing parent,
  //    append only the missing leaf — so string comparison is apples-to-apples
  //    for leaves that don't exist yet. Missing intermediates and dangling
  //    symlinks are rejected: both represent races where an attacker could
  //    materialize an outside target between validation and use.
  if (baseDir !== undefined) {
    const baseResult = canonicalizeExisting(baseDir);
    const pathResult = canonicalizeExisting(resolve(baseDir, path));
    if (!baseResult.ok) {
      return {
        ok: false,
        reason:
          baseResult.reason === "dangling-symlink"
            ? `Base directory contains a dangling symlink (${baseResult.component})`
            : `Base directory is missing (${baseResult.component}); it must exist before validation`,
        pattern: baseResult.component,
        category: "path-traversal",
      };
    }
    if (!pathResult.ok) {
      return {
        ok: false,
        reason:
          pathResult.reason === "dangling-symlink"
            ? `Path contains a dangling symlink (${pathResult.component}); its target may race an outside file`
            : `Path's parent directory does not exist (${pathResult.component}); mkdir -p the parent before validating, so only the leaf can be absent`,
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
