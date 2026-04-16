/**
 * Scoped filesystem wrapper — restricts a FileSystemBackend to a root path
 * with configurable read-only or read-write access.
 *
 * Uses resolve + startsWith guard for traversal prevention.
 * All paths are normalized once at call time; the compiled scope is
 * created once at construction time (compile-once pattern).
 */

import { resolve, sep } from "node:path";
import type { FileSearchResult, FileSystemBackend, KoiError, Result } from "@koi/core";
import { permission } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileSystemScope {
  readonly root: string;
  readonly mode: "ro" | "rw";
}

/** Pre-compiled filesystem scope for efficient per-call path validation. */
export interface CompiledFileSystemScope {
  /** Absolute, normalized root path. */
  readonly root: string;
  /** root + path.sep — for efficient startsWith boundary check. */
  readonly rootWithSep: string;
  readonly mode: "ro" | "rw";
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compileFileSystemScope(scope: FileSystemScope): CompiledFileSystemScope {
  const root = resolve(scope.root);
  return {
    root,
    rootWithSep: root + sep,
    mode: scope.mode,
  };
}

// ---------------------------------------------------------------------------
// Path normalization + boundary check
// ---------------------------------------------------------------------------

function normalizePath(
  userPath: string,
  compiled: CompiledFileSystemScope,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: KoiError } {
  const resolved = resolve(compiled.root, userPath);
  if (resolved !== compiled.root && !resolved.startsWith(compiled.rootWithSep)) {
    return {
      ok: false,
      error: permission(
        `Access to '${resolved}' was blocked: path escapes root '${compiled.root}'. ` +
          `All file operations are restricted to '${compiled.root}' and its subdirectories.`,
      ),
    };
  }
  return { ok: true, value: resolved };
}

// ---------------------------------------------------------------------------
// Write guard
// ---------------------------------------------------------------------------

function writeGuard(operation: string, compiled: CompiledFileSystemScope): KoiError | undefined {
  if (compiled.mode === "ro") {
    return permission(
      `${operation} was blocked: filesystem scope is read-only. ` +
        `Only read, list, and search operations are permitted on '${compiled.root}'.`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Search result filtering
// ---------------------------------------------------------------------------

/**
 * Filters search results to only include matches within the compiled root.
 * Handles both sync and async backend responses.
 */
function filterSearchResults(
  raw: Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>>,
  compiled: CompiledFileSystemScope,
): Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>> {
  if (raw instanceof Promise) {
    return raw.then((r) => applySearchFilter(r, compiled));
  }
  return applySearchFilter(raw, compiled);
}

function applySearchFilter(
  result: Result<FileSearchResult, KoiError>,
  compiled: CompiledFileSystemScope,
): Result<FileSearchResult, KoiError> {
  if (!result.ok) return result;
  const filtered = result.value.matches.filter((m) => {
    const resolved = resolve(m.path);
    return resolved === compiled.root || resolved.startsWith(compiled.rootWithSep);
  });
  return { ok: true, value: { matches: filtered, truncated: result.value.truncated } };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedFileSystem(
  backend: FileSystemBackend,
  scope: FileSystemScope,
): FileSystemBackend {
  const compiled = compileFileSystemScope(scope);

  // Build optional method objects conditionally to satisfy exactOptionalPropertyTypes.
  // Capture method references to avoid non-null assertions in the delegating closures.
  const del = backend.delete;
  const scopedDelete: Pick<FileSystemBackend, "delete"> = del
    ? {
        delete: (filePath: string) => {
          const guard = writeGuard("Delete", compiled);
          if (guard !== undefined)
            return { ok: false, error: guard } satisfies Result<never, KoiError>;
          const norm = normalizePath(filePath, compiled);
          if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
          return del(norm.value);
        },
      }
    : {};

  const ren = backend.rename;
  const scopedRename: Pick<FileSystemBackend, "rename"> = ren
    ? {
        rename: (from: string, to: string) => {
          const guard = writeGuard("Rename", compiled);
          if (guard !== undefined)
            return { ok: false, error: guard } satisfies Result<never, KoiError>;
          const normFrom = normalizePath(from, compiled);
          if (!normFrom.ok)
            return { ok: false, error: normFrom.error } satisfies Result<never, KoiError>;
          const normTo = normalizePath(to, compiled);
          if (!normTo.ok)
            return { ok: false, error: normTo.error } satisfies Result<never, KoiError>;
          return ren(normFrom.value, normTo.value);
        },
      }
    : {};

  const resolveFn = backend.resolvePath;
  const scopedResolvePath: Pick<FileSystemBackend, "resolvePath"> = resolveFn
    ? {
        resolvePath: (path: string): string | undefined => {
          // Apply our own scope boundary check first — if path escapes scope,
          // return undefined regardless of what the inner backend says.
          const resolved = resolve(compiled.root, path);
          if (resolved !== compiled.root && !resolved.startsWith(compiled.rootWithSep)) {
            return undefined;
          }
          return resolveFn(path);
        },
      }
    : {};

  const dispose = backend.dispose;
  const scopedDispose: Pick<FileSystemBackend, "dispose"> = dispose
    ? { dispose: () => dispose() }
    : {};

  return {
    name: `scoped(${backend.name})`,

    read(filePath, options) {
      const norm = normalizePath(filePath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.read(norm.value, options);
    },

    write(filePath, content, options) {
      const guard = writeGuard("Write", compiled);
      if (guard !== undefined) return { ok: false, error: guard } satisfies Result<never, KoiError>;
      const norm = normalizePath(filePath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.write(norm.value, content, options);
    },

    edit(filePath, edits, options) {
      const guard = writeGuard("Edit", compiled);
      if (guard !== undefined) return { ok: false, error: guard } satisfies Result<never, KoiError>;
      const norm = normalizePath(filePath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.edit(norm.value, edits, options);
    },

    list(dirPath, options) {
      const norm = normalizePath(dirPath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.list(norm.value, options);
    },

    // search() delegates to the backend then filters results to enforce
    // root boundary. The backend interface has no root parameter, so we
    // must post-filter matches whose paths escape the scoped root.
    search(pattern, options) {
      const raw = backend.search(pattern, options);
      return filterSearchResults(raw, compiled);
    },

    ...scopedDelete,
    ...scopedRename,
    ...scopedResolvePath,
    ...scopedDispose,
  };
}
