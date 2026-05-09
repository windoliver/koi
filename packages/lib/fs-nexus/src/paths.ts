/**
 * Path safety — security-critical path resolution for Nexus filesystem.
 *
 * Ported from v1 archive/v1/packages/fs/filesystem-nexus/src/nexus-filesystem-backend.ts
 * with the same attack prevention: null bytes, percent-encoding, backslash normalization,
 * traversal detection, basePath boundary enforcement.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Join basePath with a user-provided path and normalize traversals.
 *
 * Prevents path traversal attacks by:
 * - Rejecting null bytes
 * - Normalizing backslash separators
 * - Decoding percent-encoded sequences
 * - Resolving `..` segments
 * - Verifying result stays within basePath boundary
 *
 * Returns a Result — traversal attempts produce VALIDATION errors.
 */
export function computeFullPath(basePath: string, userPath: string): Result<string, KoiError> {
  // Reject null bytes
  if (userPath.includes("\0")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Path contains null bytes",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Normalize backslash separators and decode percent-encoded sequences
  let normalized: string;
  try {
    normalized = decodeURIComponent(userPath.replace(/\\/g, "/"));
  } catch {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Path contains malformed percent-encoding: '${userPath}'`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const normalizedBasePath = normalizeBasePath(basePath);

  // Strip leading slash to avoid double-slash when joining
  const normalizedUser = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const joined =
    normalizedBasePath.length > 0 ? `${normalizedBasePath}/${normalizedUser}` : normalizedUser;

  // Resolve ".." segments
  const parts = joined.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (resolved.length === 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Path traversal rejected: '${userPath}' escapes basePath '${basePath}'`,
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
      resolved.pop();
    } else if (part !== "" && part !== ".") {
      resolved.push(part);
    }
  }
  // Nexus NFS expects paths with leading slash
  const result = resolved.length > 0 ? `/${resolved.join("/")}` : "/";

  if (normalizedBasePath.length === 0) {
    return { ok: true, value: result };
  }

  // Ensure result stays within basePath boundary
  const normalizedBase = `/${normalizedBasePath}`;
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  if (result !== normalizedBase && !result.startsWith(baseWithSlash)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Path traversal rejected: '${userPath}' escapes basePath '${basePath}'`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: result };
}

/**
 * Strip basePath prefix from a full path, returning the user-relative path.
 */
export function stripBasePath(base: string, fullPath: string): string {
  const normalizedFullPath = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  const normalizedBasePath = normalizeBasePath(base);
  if (normalizedBasePath.length === 0) {
    return normalizedFullPath;
  }
  // Normalize: basePath may lack leading slash but Nexus paths always have one
  const normalizedBase = `/${normalizedBasePath}`;
  // Exact match: path IS the base directory
  if (normalizedFullPath === normalizedBase) {
    return "/";
  }
  // Path-boundary check: ensure base is followed by "/" to prevent
  // sibling-prefix collisions (e.g. base="/fs" must not match "/fspath/a.txt")
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  if (normalizedFullPath.startsWith(baseWithSlash)) {
    return `/${normalizedFullPath.slice(baseWithSlash.length)}`;
  }
  return normalizedFullPath;
}

/**
 * Higher-order function that resolves a user path within basePath,
 * then calls the provided operation — or returns the path error.
 * Eliminates the `computeFullPath + early return` boilerplate.
 */
export async function withSafePath<T>(
  basePath: string,
  userPath: string,
  fn: (fullPath: string) => Promise<Result<T, KoiError>>,
): Promise<Result<T, KoiError>> {
  const resolved = computeFullPath(basePath, userPath);
  if (!resolved.ok) return resolved;
  return fn(resolved.value);
}
