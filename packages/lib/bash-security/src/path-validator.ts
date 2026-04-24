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
    // Raw directory traversal: ../ or ..\ or bare .. at end of path,
    // OR literal `..` followed by a URL-encoded separator (`%2f`, `%5c`,
    // double-encoded `%252f`, `%255c`). A caller that URL-decodes after
    // validation would otherwise see `..` + `/` and escape the base.
    regex: /\.\.(\/|\\|%2f|%5c|%252f|%255c|$)/i,
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
    // Mixed literal + encoded dot: `%2e.` or `.%2e` decodes to `..`
    regex: /(?:%2e\.|\.%2e)(?:\/|\\|%2f|%5c|$)/i,
    category: "path-traversal",
    reason: "Mixed literal + URL-encoded directory traversal detected",
  },
  {
    // Mixed double-encoded dot: `%252e.` or `.%252e` decodes to `..`
    regex: /(?:%252e\.|\.%252e)(?:\/|\\|%2f|%5c|$)/i,
    category: "path-traversal",
    reason: "Mixed literal + double-URL-encoded directory traversal detected",
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
 * Perform one pass of URL decoding on `%XX` sequences for traversal-relevant
 * bytes only:
 *   `.` 0x2e, `/` 0x2f, `\` 0x5c, null 0x00
 *   `%` 0x25 — needed so multi-level encoding chains like `%252e` unwind
 *              (`%25` → `%`, next pass sees `%2e` → `.`)
 * Other codes stay intact so `%20` is not turned into whitespace that
 * subsequent passes misread.
 */
function decodeOnce(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
    const code = parseInt(hex, 16);
    if (code === 0x2e || code === 0x2f || code === 0x5c || code === 0x00 || code === 0x25) {
      return String.fromCharCode(code);
    }
    return match;
  });
}

/**
 * Iteratively URL-decode the path up to a small fixed depth, checking
 * traversal patterns after each decode pass. Defeats mixed single/double-
 * encoded variants like `%252e.%252fetc` or `.%252e%252fetc` that an
 * ad-hoc regex enumeration can miss: each pass rewrites some encoded
 * triplets to their literal forms, and traversal checks re-run against
 * the partially-decoded string.
 *
 * Depth bound (4) covers single, double, and triple encoding with
 * headroom; deeper chains are not seen in real-world callers and would
 * signal a path that should be rejected outright anyway.
 */
function checkIterativePathTraversal(path: string): ClassificationResult {
  let current = path;
  const maxDepth = 4;
  for (let i = 0; i < maxDepth; i++) {
    const result = matchPatterns(current, PATH_TRAVERSAL_PATTERNS, {
      normalize: false,
    });
    if (!result.ok) return result;
    const next = decodeOnce(current);
    if (next === current) return { ok: true };
    current = next;
  }
  // After max depth, if the path would STILL decode further, it is a
  // pathologically-encoded input that almost certainly hides a traversal
  // sequence. Reject outright rather than silently accept the deepest form.
  if (decodeOnce(current) !== current) {
    return {
      ok: false,
      reason: `Path exceeds ${maxDepth} URL-decode passes without stabilizing; reject pathologically-encoded input`,
      pattern: `decode-depth>${maxDepth}`,
      category: "path-traversal",
    };
  }
  return { ok: true };
}

/**
 * Result of canonicalization — either a resolved path, or a rejection signal.
 * Dangling symlinks and missing intermediates both represent TOCTOU hazards:
 * their target (or an intermediate directory) may be created/swapped-in
 * between validation and use, so they must not be treated as safe.
 */
type CanonicalResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "dangling-symlink"; readonly component: string }
  | { readonly ok: false; readonly reason: "missing-intermediate"; readonly component: string }
  | { readonly ok: false; readonly reason: "not-a-directory"; readonly component: string };

/**
 * Canonicalize the base directory. The base MUST exist as a real directory
 * (not a symlink, not a file) and realpath cleanly. Without this, a caller
 * that passes a not-yet-existing base can pass containment checks against a
 * base that an attacker later materializes as a symlink outside the intended
 * scope.
 */
function canonicalizeBase(p: string): CanonicalResult {
  const absolute = resolve(p);
  try {
    const real = realpathSync(absolute);
    const stat = lstatSync(real);
    if (!stat.isDirectory()) {
      return { ok: false, reason: "not-a-directory", component: absolute };
    }
    return { ok: true, path: real };
  } catch {
    // Base missing or dangling. Distinguish: if base is a symlink whose
    // target does not exist, that is a dangling-symlink rejection.
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: "dangling-symlink", component: absolute };
      }
    } catch {
      // Base does not exist at all.
    }
    return { ok: false, reason: "missing-intermediate", component: absolute };
  }
}

/**
 * Canonicalize a candidate path. At most the final path component (the leaf)
 * may be missing; every intermediate directory must already exist. Reject
 * dangling symlinks and any form where more than the leaf is absent, because
 * a concurrent actor could materialize an attacker-controlled symlink at a
 * missing intermediate between validation and the subsequent open/write.
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
 * **Residual TOCTOU (important, callers must read)**: even with strict
 * intermediates, a missing leaf is inherently non-atomic with its later use.
 * Between `validatePath` returning `ok` and the caller opening the path, the
 * leaf OR its parent directory can be replaced with a symlink to an outside
 * target. `validatePath` returns only a boolean/classification, so callers
 * cannot bind the subsequent filesystem call to the validated canonical
 * entry. This gap cannot be closed with a point-in-time string check alone.
 *
 * Mitigations callers MUST apply for security-sensitive writes:
 *   1. `mkdir -p` the parent directory before validating, so only the leaf
 *      is absent.
 *   2. Open with `O_NOFOLLOW` on the leaf and `openat()`-style no-follow
 *      descent for each intermediate. Use `fs.openSync(path, fs.constants.O_NOFOLLOW | fs.constants.O_CREAT)`
 *      or equivalent — raw `fs.writeFileSync` does NOT provide this.
 *   3. Re-validate immediately before the write, and prefer `fs.realpathSync`
 *      on the written file descriptor after open to confirm containment.
 * Callers that cannot guarantee any of the above must NOT rely on
 * `validatePath` as the sole write-authorization check.
 *
 * @param path - The path string to validate.
 * @param baseDir - If provided, the canonicalized path must be a descendant.
 */
export function validatePath(path: string, baseDir?: string): ClassificationResult {
  // 1. Iterative traversal check: run PATH_TRAVERSAL_PATTERNS against the raw
  //    string first, then against each URL-decoded form up to a small fixed
  //    depth. Single and double encoding plus mixed literal/encoded variants
  //    all decode to `../` within a few passes; iterative decode + re-check
  //    catches every combination an ad-hoc regex enumeration would miss.
  //    Path strings can legitimately contain `\` (on Windows paths) so we do
  //    NOT apply the shell-command normalizer here — it would strip
  //    backslashes and erase the `..\\` traversal signal.
  const patternResult = checkIterativePathTraversal(path);
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
    const baseResult = canonicalizeBase(baseDir);
    if (!baseResult.ok) {
      const baseReason =
        baseResult.reason === "dangling-symlink"
          ? `Base directory contains a dangling symlink (${baseResult.component})`
          : baseResult.reason === "not-a-directory"
            ? `Base directory is not a directory (${baseResult.component})`
            : `Base directory is missing (${baseResult.component}); it must exist as a real directory before validation`;
      return {
        ok: false,
        reason: baseReason,
        pattern: baseResult.component,
        category: "path-traversal",
      };
    }
    const pathResult = canonicalizeExisting(resolve(baseResult.path, path));
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
