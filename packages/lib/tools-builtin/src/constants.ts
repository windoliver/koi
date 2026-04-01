import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export const BUILTIN_SEARCH_OPERATIONS = ["Glob", "Grep", "ToolSearch"] as const;
export type BuiltinSearchOperation = (typeof BUILTIN_SEARCH_OPERATIONS)[number];

export const DEFAULT_HEAD_LIMIT = 250;
export const DEFAULT_MAX_RESULTS = 5;

/** Max file size (bytes) the native grep fallback will read. Skip binary/huge files. */
export const MAX_NATIVE_GREP_FILE_SIZE = 1_048_576; // 1 MiB

type ClampResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a user-supplied path and clamp it to the workspace root.
 * Resolves symlinks via realpath so a symlinked path that points
 * outside the workspace is rejected.
 */
export function clampPath(raw: string, cwd: string): ClampResult {
  const resolved = resolve(cwd, raw);

  // Lexical check first (catches ../traversal without needing the path to exist)
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    return { ok: false, error: `Path "${raw}" escapes the workspace root` };
  }

  // Canonical (symlink-resolved) check — the target must also be under cwd
  try {
    const canonicalCwd = realpathSync(cwd);
    const canonicalTarget = realpathSync(resolved);
    if (canonicalTarget !== canonicalCwd && !canonicalTarget.startsWith(canonicalCwd + sep)) {
      return { ok: false, error: `Path "${raw}" resolves outside the workspace root (symlink)` };
    }
  } catch {
    // Path doesn't exist yet — lexical check above is sufficient
  }

  return { ok: true, path: resolved };
}

/** Traversal segments that can escape the scan root when embedded in a glob pattern. */
const TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Reject glob patterns that contain path traversal (`..`) or are absolute paths.
 * Returns an error string if the pattern is unsafe, or undefined if safe.
 */
export function validateGlobPattern(pattern: string): string | undefined {
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
    return `Glob pattern "${pattern}" must be relative, not absolute`;
  }
  if (TRAVERSAL_RE.test(pattern)) {
    return `Glob pattern "${pattern}" must not contain ".." traversal segments`;
  }
  return undefined;
}

/** Common regex metacharacters that indicate the pattern needs a real regex engine. */
const REGEX_META_RE = /[\\^$.|?*+()[\]{}]/;

/** Returns true if the pattern contains regex metacharacters that literal matching cannot honor. */
export function looksLikeRegex(pattern: string): boolean {
  return REGEX_META_RE.test(pattern);
}
