/**
 * Shared path resolution for local filesystem operations.
 *
 * Two resolution modes:
 * - Backend mode (`absolute: false`, default): preserves FileSystemBackend
 *   contract convention where leading "/" is stripped and treated as workspace-
 *   relative. Used by the fs-local backend for backward compatibility.
 * - Absolute mode (`absolute: true`): treats leading "/" as a real absolute
 *   path. Used by the permission middleware's resolveToolPath callback to
 *   produce the canonical path for rule evaluation.
 *
 * Security boundary is the permission middleware, not the filesystem backend.
 */

import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Safe synchronous stat — returns undefined instead of throwing on ENOENT.
 * Used by the path disambiguation heuristic to check if a root-level directory exists.
 */
function statSyncSafe(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

export interface ResolveFsPathOptions {
  /**
   * When true, leading "/" is treated as a real absolute path (e.g.
   * "/etc/passwd" → the host /etc/passwd). When false (default), leading
   * "/" is stripped and the path is treated as workspace-relative per the
   * FileSystemBackend contract convention.
   */
  readonly absolute?: boolean;
}

/**
 * Resolve a user-provided path to an absolute filesystem path.
 *
 * @param path - User-provided path from tool input
 * @param root - Workspace root directory (realpath-resolved at construction time)
 * @param options - Resolution options (default: workspace-relative mode)
 * @returns Absolute filesystem path
 */
export function resolveFsPath(path: string, root: string, options?: ResolveFsPathOptions): string {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  // Strip workspace root prefix from absolute paths that include it
  // (models sometimes echo the full workspace path).
  if (path.startsWith(rootPrefix)) {
    return resolve(root, path.slice(rootPrefix.length));
  }
  if (path === root || path.startsWith(`${root}/`)) {
    return path === root ? root : resolve(root, path.slice(root.length + 1));
  }

  // Relative path (no leading /) — resolve against workspace root.
  if (!path.startsWith("/")) {
    return resolve(root, path);
  }

  // Absolute mode: always treat leading "/" as real absolute path.
  if (options?.absolute === true) {
    return resolve(path);
  }

  // Backend mode (default): disambiguate leading "/" paths.
  //
  // The FileSystemBackend contract convention strips "/" and treats the
  // path as workspace-relative. However, models also send real absolute
  // paths like "/Users/tafeng/Documents/file.md" or "/etc/passwd".
  //
  // Heuristic: check if the first path segment (e.g. "etc" from "/etc/passwd")
  // exists as a real directory at the filesystem root. If it does, this is
  // unambiguously a real absolute path — treat it as such. If it doesn't,
  // strip "/" and treat as workspace-relative per the contract convention.
  //
  // This correctly handles:
  // - "/etc/passwd"            → /etc exists → absolute ("/etc/passwd")
  // - "/Users/tafeng/file.md"  → /Users exists → absolute
  // - "/tmp/test.txt"          → /tmp exists → absolute
  // - "/src/index.ts"          → /src doesn't exist → workspace-relative
  // - "/contract/read.txt"     → /contract doesn't exist → workspace-relative
  //
  // The heuristic is synchronous (statSync) and runs once per path resolution.
  // It's cached implicitly by the OS filesystem cache.
  const firstSegment = path.slice(1).split("/")[0];
  if (firstSegment !== undefined && firstSegment.length > 0) {
    try {
      const s = statSyncSafe(`/${firstSegment}`);
      if (s !== undefined) {
        // First segment exists at filesystem root — treat as real absolute path.
        return resolve(path);
      }
    } catch {
      // statSync failed — treat as workspace-relative.
    }
  }
  // First segment doesn't exist at root — workspace-relative contract convention.
  const stripped = path.slice(1);
  return resolve(root, stripped);
}

/** Result of path resolution with coercion metadata. */
export interface ResolvedFsPath {
  /** Absolute filesystem path the backend will operate on. */
  readonly absolute: string;
  /**
   * Workspace-relative path when the input was coerced (leading "/" stripped
   * and resolved under workspace root). Undefined when no coercion occurred
   * (relative input or real absolute path).
   */
  readonly resolvedPath: string | undefined;
}

/**
 * Like `resolveFsPath` but also reports whether the path was coerced from
 * an absolute-looking input to a workspace-relative path. Used by the backend
 * to populate `resolvedPath` in result types so tool factories can surface
 * coercion notes to the model.
 */
export function resolveFsPathWithCoercion(
  path: string,
  root: string,
  options?: ResolveFsPathOptions,
): ResolvedFsPath {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  // Workspace-prefixed absolute paths — strip prefix (not coercion, just normalization)
  if (path.startsWith(rootPrefix)) {
    return { absolute: resolve(root, path.slice(rootPrefix.length)), resolvedPath: undefined };
  }
  if (path === root || path.startsWith(`${root}/`)) {
    return {
      absolute: path === root ? root : resolve(root, path.slice(root.length + 1)),
      resolvedPath: undefined,
    };
  }

  // Relative path — no coercion
  if (!path.startsWith("/")) {
    return { absolute: resolve(root, path), resolvedPath: undefined };
  }

  // Absolute mode — no coercion
  if (options?.absolute === true) {
    return { absolute: resolve(path), resolvedPath: undefined };
  }

  // Backend mode: heuristic disambiguation
  const firstSegment = path.slice(1).split("/")[0];
  if (firstSegment !== undefined && firstSegment.length > 0) {
    try {
      const s = statSyncSafe(`/${firstSegment}`);
      if (s !== undefined) {
        // Real absolute path — no coercion
        return { absolute: resolve(path), resolvedPath: undefined };
      }
    } catch {
      // Fall through to workspace-relative
    }
  }

  // Coerced: leading "/" stripped, treated as workspace-relative
  const stripped = path.slice(1);
  return { absolute: resolve(root, stripped), resolvedPath: stripped };
}
