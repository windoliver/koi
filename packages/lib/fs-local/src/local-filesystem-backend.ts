/**
 * Local filesystem backend — uses Bun.file/node:fs for file operations.
 *
 * Security boundary is the permission middleware, NOT this backend.
 * The backend is pure I/O — it reads/writes any path it receives.
 * Symlink hardening is applied as defense-in-depth for workspace paths.
 * Implements the L0 FileSystemBackend contract.
 */

import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  FileDeleteResult,
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileListEntry,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileSearchMatch,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  KoiErrorCode,
  Result,
} from "@koi/core";
import { resolveFsPath, resolveFsPathWithCoercion } from "./path-resolution.js";

function err(code: KoiErrorCode, message: string, cause?: unknown): KoiError {
  return {
    code,
    message,
    retryable: false,
    ...(cause !== undefined ? { cause } : {}),
  };
}

/** Map a filesystem error to the appropriate KoiErrorCode based on errno. */
function mapFsError(e: unknown, path: string): KoiError {
  if (e instanceof Error && "code" in e) {
    const code = (e as { code: string }).code;
    if (code === "ENOENT") return err("NOT_FOUND", `File not found: ${path}`, e);
    if (code === "EACCES" || code === "EPERM")
      return err("PERMISSION", `Permission denied: ${path}`, e);
    if (code === "EEXIST") return err("CONFLICT", `File already exists: ${path}`, e);
    if (code === "EXDEV")
      return err("VALIDATION", `Cross-device operation not supported: ${path}`, e);
  }
  return err("INTERNAL", `Filesystem operation failed: ${path}`, e);
}

/** Normalize a path to forward slashes for consistent API responses. */
function toApiPath(p: string): string {
  return sep === "\\" ? p.replaceAll("\\", "/") : p;
}

export interface LocalFileSystemOptions {
  /**
   * When true, absolute paths outside the workspace root are allowed.
   * Security boundary shifts to the permission middleware.
   * Default: false (workspace-only — all paths resolved under root).
   */
  readonly allowExternalPaths?: boolean;
}

/** Create a local filesystem backend rooted at `rootPath`. */
export function createLocalFileSystem(
  rootPath: string,
  options?: LocalFileSystemOptions,
): FileSystemBackend {
  // Resolve the root with realpath so symlinked roots are handled correctly.
  // Uses sync because this runs once at construction time.
  const root = realpathSync(resolve(rootPath));

  // Append path separator so /Users/foo/koi doesn't match /Users/foo/koi2
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  /**
   * Resolve a user path to an absolute filesystem path.
   * Delegates to the shared resolveFsPath utility.
   */
  function resolveLocal(path: string): string {
    return resolveFsPath(path, root);
  }

  /**
   * Resolve with coercion tracking — returns both the absolute path and
   * optional resolvedPath when leading "/" was coerced to workspace-relative.
   */
  function resolveLocalWithCoercion(path: string): {
    readonly absolute: string;
    readonly resolvedPath: string | undefined;
  } {
    return resolveFsPathWithCoercion(path, root);
  }

  /**
   * Check if an absolute path is under the workspace root.
   */
  function isUnderRoot(resolved: string): boolean {
    return resolved === root || resolved.startsWith(rootPrefix);
  }

  const allowExternal = options?.allowExternalPaths === true;

  /**
   * Resolve path + containment check + symlink hardening.
   *
   * Default mode (allowExternalPaths=false): blocks paths outside workspace.
   * External mode (allowExternalPaths=true): allows out-of-workspace paths
   * (security boundary shifts to the permission middleware).
   *
   * Symlink containment is checked for workspace paths in both modes, and
   * for external paths in external mode (resolves symlink target before I/O).
   */
  async function safePath(path: string): Promise<Result<string, KoiError>> {
    const resolved = resolveLocal(path);

    // Block external paths when not explicitly allowed.
    if (!allowExternal && !isUnderRoot(resolved)) {
      return { ok: false, error: err("PERMISSION", `Path outside workspace: ${path}`) };
    }

    // Symlink hardening for workspace paths.
    if (isUnderRoot(resolved)) {
      // Walk up to find the nearest existing path component, then realpath it.
      // This handles both existing files and not-yet-created paths (write/rename).
      // let: mutable — walks up the directory tree
      let check = resolved;
      for (;;) {
        try {
          const real = await realpath(check);
          // Verify the real path is still under the workspace root
          if (real !== root && !real.startsWith(rootPrefix)) {
            return {
              ok: false,
              error: err("PERMISSION", `Path escapes workspace via symlink: ${path}`),
            };
          }
          break;
        } catch {
          // Path doesn't exist yet — check its parent
          const parent = dirname(check);
          if (parent === check) break; // Reached filesystem root
          check = parent;
        }
      }
    }

    return { ok: true, value: resolved };
  }

  /**
   * Check if an absolute path is contained within the workspace root
   * after resolving symlinks. Used by search() and list() for glob results
   * to catch in-workspace symlinks that escape to external locations.
   *
   * Only relevant when the list/search target is itself under the workspace
   * root — out-of-workspace targets skip this check entirely (permission-gated).
   */
  async function isContained(absolutePath: string): Promise<boolean> {
    try {
      const real = await realpath(absolutePath);
      return real === root || real.startsWith(rootPrefix);
    } catch {
      // Path doesn't exist — check nearest ancestor
      const parent = dirname(absolutePath);
      if (parent === absolutePath) return true; // Reached fs root
      return isContained(parent);
    }
  }

  /**
   * Reject symlinks whose target escapes the workspace root. Called before
   * operations to shrink the TOCTOU window between safePath validation and
   * the filesystem call.
   *
   * Only checked for paths under the workspace root (defense-in-depth).
   * Out-of-workspace paths skip this check — permission middleware gates them.
   *
   * Symlinks that resolve inside the workspace are allowed — repos commonly
   * use in-workspace symlinks. Only symlinks that escape are rejected.
   */
  async function rejectEscapingSymlink(
    absolutePath: string,
    apiPath: string,
  ): Promise<Result<void, KoiError>> {
    // External paths: check if the leaf itself is a symlink to a different
    // file. Parent-directory symlinks (like macOS /etc → /private/etc) are
    // allowed — they're system-level mounts, not attack vectors. Only the
    // leaf-level redirect is blocked.
    if (!isUnderRoot(absolutePath)) {
      try {
        const s = await lstat(absolutePath);
        if (s.isSymbolicLink()) {
          return {
            ok: false,
            error: err(
              "PERMISSION",
              `External symlink rejected: ${apiPath} is a symlink (approved path must not be a symlink)`,
            ),
          };
        }
      } catch {
        // Path doesn't exist yet (write/rename dest) — not a symlink, OK
      }
      return { ok: true, value: undefined };
    }
    try {
      const s = await lstat(absolutePath);
      if (s.isSymbolicLink()) {
        // Resolve the symlink and verify containment
        const real = await realpath(absolutePath);
        if (real !== root && !real.startsWith(rootPrefix)) {
          return { ok: false, error: err("PERMISSION", `Symlink escapes workspace: ${apiPath}`) };
        }
      }
    } catch {
      // Path doesn't exist yet (write/rename dest) — not a symlink, OK
    }
    return { ok: true, value: undefined };
  }

  const backend: FileSystemBackend = {
    name: "local",

    async read(path: string, options?: FileReadOptions): Promise<Result<FileReadResult, KoiError>> {
      const coercion = resolveLocalWithCoercion(path);
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        const file = Bun.file(p.value);
        if (!(await file.exists())) {
          return { ok: false, error: err("NOT_FOUND", `File not found: ${path}`) };
        }

        const text = await file.text();
        const lines = text.split("\n");
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? lines.length;
        const content = lines.slice(offset, offset + limit).join("\n");

        return {
          ok: true,
          value: {
            content,
            path,
            size: file.size,
            ...(coercion.resolvedPath !== undefined ? { resolvedPath: coercion.resolvedPath } : {}),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to read: ${path}`, e) };
      }
    },

    async write(
      path: string,
      content: string,
      options?: FileWriteOptions,
    ): Promise<Result<FileWriteResult, KoiError>> {
      const coercion = resolveLocalWithCoercion(path);
      const coercionField =
        coercion.resolvedPath !== undefined ? { resolvedPath: coercion.resolvedPath } : {};
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        if (options?.createDirectories !== false) {
          await mkdir(dirname(p.value), { recursive: true });
        }

        if (options?.overwrite === false) {
          try {
            await writeFile(p.value, content, { flag: "wx" });
            return {
              ok: true,
              value: { path, bytesWritten: Buffer.byteLength(content), ...coercionField },
            };
          } catch (wxErr: unknown) {
            if (wxErr instanceof Error && "code" in wxErr && wxErr.code === "EEXIST") {
              return { ok: false, error: err("CONFLICT", `File already exists: ${path}`) };
            }
            throw wxErr;
          }
        }

        const bytes = await Bun.write(p.value, content);
        return { ok: true, value: { path, bytesWritten: bytes, ...coercionField } };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to write: ${path}`, e) };
      }
    },

    async edit(
      path: string,
      edits: readonly FileEdit[],
      options?: FileEditOptions,
    ): Promise<Result<FileEditResult, KoiError>> {
      const coercion = resolveLocalWithCoercion(path);
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        const file = Bun.file(p.value);
        if (!(await file.exists())) {
          return { ok: false, error: err("NOT_FOUND", `File not found: ${path}`) };
        }

        const preStat = await stat(p.value);
        const preMs = preStat.mtimeMs;

        // let: mutable — progressively modified by each hunk
        let text = await file.text();
        // let: mutable — tracks how many hunks were applied
        let applied = 0;
        for (const edit of edits) {
          if (text.includes(edit.oldText)) {
            text = text.replace(edit.oldText, edit.newText);
            applied++;
          }
        }

        if (options?.dryRun !== true) {
          const postStat = await stat(p.value);
          if (postStat.mtimeMs !== preMs) {
            return {
              ok: false,
              error: err("CONFLICT", `File modified during edit: ${path}`),
            };
          }
          const tmpPath = `${p.value}.koi-edit-${crypto.randomUUID()}`;
          await Bun.write(tmpPath, text);
          await rename(tmpPath, p.value);
        }

        return {
          ok: true,
          value: {
            path,
            hunksApplied: applied,
            ...(coercion.resolvedPath !== undefined ? { resolvedPath: coercion.resolvedPath } : {}),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to edit: ${path}`, e) };
      }
    },

    async list(path: string, options?: FileListOptions): Promise<Result<FileListResult, KoiError>> {
      const p = await safePath(path);
      if (!p.ok) return p;

      // Skip symlink containment checks when listing outside the workspace.
      // Permission middleware already approved the target directory.
      const targetInWorkspace = isUnderRoot(p.value);

      try {
        if (options?.recursive) {
          const rawGlob = options.glob ?? "**/*";
          const glob = new Bun.Glob(rawGlob.startsWith("/") ? rawGlob.slice(1) : rawGlob);
          const entries: FileListEntry[] = [];
          for await (const match of glob.scan({ cwd: p.value, dot: false })) {
            const fullPath = join(p.value, match);
            try {
              // Skip symlinks that escape the workspace root (defense-in-depth).
              // Only applies when listing inside the workspace.
              if (targetInWorkspace && !(await isContained(fullPath))) continue;
              const s = await stat(fullPath);
              entries.push({
                path: toApiPath(join(path, match)),
                kind: s.isDirectory() ? "directory" : "file",
                ...(s.isFile() ? { size: s.size } : {}),
                modifiedAt: s.mtimeMs,
              });
            } catch {
              /* skip unreadable entries */
            }
          }
          return { ok: true, value: { entries, truncated: false } };
        }

        const dirents = await readdir(p.value, { withFileTypes: true });
        const entries: FileListEntry[] = [];
        for (const entry of dirents) {
          if (entry.name.startsWith(".")) continue;
          const fullPath = join(p.value, entry.name);

          // Skip symlinks that escape the workspace (defense-in-depth).
          // Only applies when listing inside the workspace.
          if (targetInWorkspace && entry.isSymbolicLink()) {
            if (!(await isContained(fullPath))) continue;
          }

          const kind = entry.isDirectory()
            ? ("directory" as const)
            : entry.isSymbolicLink()
              ? ("symlink" as const)
              : ("file" as const);

          // let: mutable — conditionally set from stat call
          let size: number | undefined;
          // let: mutable — conditionally set from stat call
          let modifiedAt: number | undefined;
          try {
            const s = await stat(fullPath);
            if (kind === "file") size = s.size;
            modifiedAt = s.mtimeMs;
          } catch {
            /* skip */
          }
          entries.push({
            path: toApiPath(join(path, entry.name)),
            kind,
            ...(size !== undefined ? { size } : {}),
            ...(modifiedAt !== undefined ? { modifiedAt } : {}),
          });
        }
        return { ok: true, value: { entries, truncated: false } };
      } catch (e: unknown) {
        // Only coerce ENOENT to empty list (matches Nexus behavior).
        // Propagate permission, I/O, and ENOTDIR errors so callers can
        // distinguish "empty" from "broken."
        if (e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT") {
          return { ok: true, value: { entries: [], truncated: false } };
        }
        return { ok: false, error: mapFsError(e, path) };
      }
    },

    async search(
      pattern: string,
      options?: FileSearchOptions,
    ): Promise<Result<FileSearchResult, KoiError>> {
      try {
        const maxResults = options?.maxResults ?? 100;
        const flags = options?.caseSensitive === false ? "i" : "";
        const regex = new RegExp(pattern, flags);
        // Strip leading '/' from glob — Bun.Glob scans relative to cwd
        const rawGlob = options?.glob ?? "**/*";
        const glob = new Bun.Glob(rawGlob.startsWith("/") ? rawGlob.slice(1) : rawGlob);
        const matches: FileSearchMatch[] = [];

        for await (const filePath of glob.scan({ cwd: root, dot: false })) {
          if (matches.length >= maxResults) break;
          const fullPath = join(root, filePath);
          try {
            // Skip symlinks that escape the workspace root
            if (!(await isContained(fullPath))) continue;
            const s = await stat(fullPath);
            if (!s.isFile()) continue;
            const content = await Bun.file(fullPath).text();
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
              const line = lines[i];
              if (line !== undefined && regex.test(line)) {
                matches.push({ path: toApiPath(filePath), line: i + 1, text: line.trim() });
              }
            }
          } catch {
            /* skip unreadable files */
          }
        }

        return {
          ok: true,
          value: { matches, truncated: matches.length >= maxResults },
        };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", "Search failed", e) };
      }
    },

    async delete(path: string): Promise<Result<FileDeleteResult, KoiError>> {
      const coercion = resolveLocalWithCoercion(path);
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        await unlink(p.value);
        return {
          ok: true,
          value: {
            path,
            ...(coercion.resolvedPath !== undefined ? { resolvedPath: coercion.resolvedPath } : {}),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: mapFsError(e, path) };
      }
    },

    async rename(
      from: string,
      to: string,
    ): Promise<Result<{ readonly from: string; readonly to: string }, KoiError>> {
      const fromPath = await safePath(from);
      if (!fromPath.ok) return fromPath;
      const fromSymCheck = await rejectEscapingSymlink(fromPath.value, from);
      if (!fromSymCheck.ok) return fromSymCheck;
      const toPath = await safePath(to);
      if (!toPath.ok) return toPath;

      try {
        // Ensure parent directory of destination exists
        await mkdir(dirname(toPath.value), { recursive: true });
        await rename(fromPath.value, toPath.value);
        return { ok: true, value: { from, to } };
      } catch (e: unknown) {
        return { ok: false, error: mapFsError(e, from) };
      }
    },

    /**
     * Resolve a user-provided path to an absolute filesystem path.
     *
     * Used by cross-cutting subsystems (e.g. @koi/checkpoint) to hash
     * blobs against the same path the backend writes to.
     *
     * Returns `undefined` for empty paths AND for out-of-workspace paths
     * so checkpoint never captures/restores external host files. This
     * prevents a single approved external write from expanding into
     * persistent retention + /rewind replay of host files.
     */
    resolvePath(path: string): string | undefined {
      if (path.length === 0) return undefined;
      const resolved = resolveLocal(path);
      // Never expose out-of-workspace paths to checkpoint — prevents
      // external file retention and /rewind replay beyond the approval scope.
      if (!isUnderRoot(resolved)) return undefined;
      return resolved;
    },

    dispose(): void {
      // No-op — local filesystem needs no cleanup
    },
  };

  return backend;
}
