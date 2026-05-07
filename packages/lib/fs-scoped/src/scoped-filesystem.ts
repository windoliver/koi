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

interface SemanticSearchHit {
  readonly path: string;
  readonly snippet: string;
  readonly score: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

interface SemanticSearchResponse {
  readonly results: readonly SemanticSearchHit[];
  readonly warning?: string | undefined;
}

type SemanticSearchFn = (
  query: string,
  options?: {
    readonly scope?: string;
    readonly maxResults?: number;
    readonly minScore?: number;
  },
) => Result<SemanticSearchResponse, KoiError> | Promise<Result<SemanticSearchResponse, KoiError>>;

function hasSemanticSearch(backend: FileSystemBackend): backend is FileSystemBackend & {
  readonly semanticSearch: SemanticSearchFn;
} {
  return "semanticSearch" in backend && typeof backend.semanticSearch === "function";
}

function applySemanticFilter(
  result: Result<SemanticSearchResponse, KoiError>,
  compiled: CompiledFileSystemScope,
  requestedLimit: number,
  fetchLimit: number,
): Result<SemanticSearchResponse, KoiError> {
  if (!result.ok) return result;
  const raw = result.value.results;
  // Wrapper enforces only the *root* scope. Caller-supplied `scope`/
  // `minScore` are passed through to the inner backend, which may honor
  // them natively (more accurate ranking) or fall back to client-side
  // filtering (handled inside its own implementation).
  const filtered = raw.filter((entry) => {
    const resolved = resolve(entry.path);
    return resolved === compiled.root || resolved.startsWith(compiled.rootWithSep);
  });
  const truncated = filtered.slice(0, requestedLimit);

  // If the inner backend returned the full over-fetch window AND we still
  // can't satisfy the caller's requested limit, the scope filter may have
  // hidden valid in-scope matches sitting beyond the window. Surface this
  // so callers don't treat a short result as authoritative.
  const innerHitCap = raw.length >= fetchLimit;
  const incomplete = innerHitCap && truncated.length < requestedLimit;
  const inheritedWarning = result.value.warning;
  const scopeWarning = incomplete
    ? `semantic_search may be incomplete: scoped-filesystem post-filtered the inner backend's top ${fetchLimit} hits and dropped matches outside the scope root. Tighten the query or raise maxResults.`
    : undefined;
  const warning =
    inheritedWarning !== undefined && scopeWarning !== undefined
      ? `${inheritedWarning} ${scopeWarning}`
      : (inheritedWarning ?? scopeWarning);

  return {
    ok: true,
    value: warning !== undefined ? { results: truncated, warning } : { results: truncated },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedFileSystem(
  backend: FileSystemBackend,
  scope: FileSystemScope,
): FileSystemBackend {
  const compiled = compileFileSystemScope(scope);
  const semanticSearch = hasSemanticSearch(backend)
    ? (query: string, options?: Parameters<SemanticSearchFn>[1]) => {
        const requestedLimit = options?.maxResults ?? 10;
        // Modest additive headroom so out-of-root matches at the top of
        // the inner backend's ranking don't starve in-root matches sitting
        // just below the cutoff. Kept additive (and small) so backends
        // that already over-fetch when scope/minScore are set don't see
        // a multiplicative blow-up of the inner fetch window.
        const OUTER_HEADROOM_CAP = 100;
        const headroom = Math.min(requestedLimit * 2, OUTER_HEADROOM_CAP);
        const fetchLimit = requestedLimit + headroom;
        // Preserve the caller's scope/minScore — backends are allowed to
        // honor them natively for better ranking. The wrapper applies its
        // own root-scope filter on top.
        const inner = backend.semanticSearch(query, { ...options, maxResults: fetchLimit });
        const finish = (
          r: Result<SemanticSearchResponse, KoiError>,
        ): Result<SemanticSearchResponse, KoiError> =>
          applySemanticFilter(r, compiled, requestedLimit, fetchLimit);
        return inner instanceof Promise ? inner.then(finish) : finish(inner);
      }
    : undefined;

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
          return resolveFn(resolved);
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
    ...(semanticSearch !== undefined ? { semanticSearch } : {}),
  };
}
