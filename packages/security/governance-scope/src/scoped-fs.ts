/**
 * Scoped filesystem wrapper — narrows a FileSystemBackend to a glob
 * allowlist with read-only or read-write mode.
 *
 * Path containment is enforced fail-closed in two stages:
 *   1. Lexical: `path.resolve` collapses `..` segments.
 *   2. Physical: `realpathSync` follows symlinks. For paths that do not
 *      exist yet (write of a new file), we walk up to the nearest existing
 *      ancestor, realpath that, then re-attach the missing tail. This
 *      defends against symlink-escape both for existing and not-yet-existing
 *      targets.
 *
 * After resolution, the absolute path must match at least one allowed
 * glob (slash-normalized for cross-platform consistency). Any error during
 * path resolution → PERMISSION (fail-closed).
 *
 * Read-only mode rejects every mutating operation regardless of scope.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { FileSearchResult, FileSystemBackend, KoiError, Result } from "@koi/core";
import { permission } from "@koi/core";
import { compileGlobs, matchAny } from "./glob.js";

export interface ScopedFsOptions {
  readonly allow: readonly string[];
  readonly mode: "ro" | "rw";
}

export interface CompiledScopedFs {
  readonly allow: readonly RegExp[];
  readonly mode: "ro" | "rw";
}

export function compileScopedFs(opts: ScopedFsOptions): CompiledScopedFs {
  return {
    allow: compileGlobs(opts.allow.map(toPosix)),
    mode: opts.mode,
  };
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Resolve `userPath` to its real, symlink-free absolute form. For paths
 * whose final segment does not yet exist (e.g. a file being written for
 * the first time), the deepest existing ancestor is realpath'd and the
 * remaining segments are appended verbatim — these tail segments cannot
 * be a symlink because they have not been created yet.
 *
 * Returns `undefined` when realpath fails for any reason other than
 * ENOENT (e.g. EACCES, ELOOP). Callers treat `undefined` as fail-closed.
 */
function resolveReal(userPath: string): string | undefined {
  const abs = isAbsolute(userPath) ? userPath : resolve(userPath);

  try {
    return realpathSync(abs);
  } catch (err) {
    if (!isEnoent(err)) return undefined;
  }

  // Walk up until an existing ancestor is found.
  let current = dirname(abs);
  const tail: string[] = [];
  let basename = abs.slice(current.length + 1);
  tail.push(basename);

  while (true) {
    try {
      const realAncestor = realpathSync(current);
      return tail.reduceRight((acc, seg) => `${acc}${sep}${seg}`, realAncestor);
    } catch (err) {
      if (!isEnoent(err)) return undefined;
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root with no existing ancestor — fail closed.
      return undefined;
    }
    basename = current.slice(parent.length + 1);
    tail.push(basename);
    current = parent;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function normalizePath(
  userPath: string,
  compiled: CompiledScopedFs,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: KoiError } {
  const real = resolveReal(userPath);
  if (real === undefined) {
    return {
      ok: false,
      error: permission(
        `Access to '${userPath}' was blocked: path resolution failed (fail-closed).`,
      ),
    };
  }
  if (!matchAny(toPosix(real), compiled.allow)) {
    return {
      ok: false,
      error: permission(`Access to '${real}' was blocked: path is outside the allowed scope.`),
    };
  }
  return { ok: true, value: real };
}

function writeGuard(operation: string, compiled: CompiledScopedFs): KoiError | undefined {
  if (compiled.mode === "ro") {
    return permission(`${operation} was blocked: filesystem scope is read-only.`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

function filterSearchResults(
  raw: Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>>,
  compiled: CompiledScopedFs,
): Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>> {
  if (raw instanceof Promise) {
    return raw.then((r) => applySearchFilter(r, compiled));
  }
  return applySearchFilter(raw, compiled);
}

function applySearchFilter(
  result: Result<FileSearchResult, KoiError>,
  compiled: CompiledScopedFs,
): Result<FileSearchResult, KoiError> {
  if (!result.ok) return result;
  const filtered = result.value.matches.filter((m) => {
    const real = resolveReal(m.path);
    if (real === undefined) return false;
    return matchAny(toPosix(real), compiled.allow);
  });
  return { ok: true, value: { matches: filtered, truncated: result.value.truncated } };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedFs(
  backend: FileSystemBackend,
  opts: ScopedFsOptions,
): FileSystemBackend {
  const compiled = compileScopedFs(opts);

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
        resolvePath: (p: string): string | undefined => {
          const real = resolveReal(p);
          if (real === undefined) return undefined;
          if (!matchAny(toPosix(real), compiled.allow)) return undefined;
          return resolveFn(real);
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

    search(pattern, options) {
      // Search patterns are not paths — delegate to backend then filter
      // results against the scope.
      const raw = backend.search(pattern, options);
      return filterSearchResults(raw, compiled);
    },

    ...scopedDelete,
    ...scopedRename,
    ...scopedResolvePath,
    ...scopedDispose,
  };
}
