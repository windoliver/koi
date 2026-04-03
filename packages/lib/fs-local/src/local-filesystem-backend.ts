/**
 * Local filesystem backend — uses Bun.file/node:fs for file operations.
 *
 * Scoped to a root directory with path traversal prevention.
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

/** Create a local filesystem backend rooted at `rootPath`. */
export function createLocalFileSystem(rootPath: string): FileSystemBackend {
  // Resolve the root with realpath so symlinked roots are handled correctly.
  // Uses sync because this runs once at construction time.
  const root = realpathSync(resolve(rootPath));

  // Append path separator so /Users/foo/koi doesn't match /Users/foo/koi2
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  /**
   * Lexical path check — prevents ".." traversal.
   *
   * Path convention: All paths are workspace-relative per the FileSystemBackend
   * contract. Leading "/" is stripped (e.g., "/src/index.ts" → "src/index.ts").
   * Absolute paths that match the workspace root prefix are also accepted and
   * stripped (e.g., "/Users/foo/workspace/src/index.ts" → "src/index.ts").
   *
   * The symlink containment check in safePath() prevents actual filesystem
   * escape regardless of the input path.
   */
  function lexicalCheck(path: string): Result<string, KoiError> {
    // Strip workspace root prefix from absolute paths that include it
    // (models sometimes send full absolute paths).
    // For all other paths, strip leading "/" to treat as workspace-relative
    // (the FileSystemBackend contract convention).
    const stripped = path.startsWith(rootPrefix)
      ? path.slice(rootPrefix.length)
      : path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : path.startsWith("/")
          ? path.slice(1)
          : path;
    const resolved = resolve(root, stripped);
    // Allow exact root or any child path (prefix includes trailing slash)
    if (resolved !== root && !resolved.startsWith(rootPrefix)) {
      return { ok: false, error: err("PERMISSION", `Path outside workspace: ${path}`) };
    }
    return { ok: true, value: resolved };
  }

  /**
   * Full path check — lexical check + symlink containment.
   *
   * After the lexical check passes, walks up from the resolved path to find
   * the nearest existing ancestor, resolves it with realpath, and verifies
   * the real path is still under the workspace root. This prevents symlinks
   * inside the workspace from escaping the sandbox.
   */
  async function safePath(path: string): Promise<Result<string, KoiError>> {
    const lexical = lexicalCheck(path);
    if (!lexical.ok) return lexical;
    const resolved = lexical.value;

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

    return { ok: true, value: resolved };
  }

  /**
   * Check if an absolute path is contained within the workspace root
   * after resolving symlinks. Used by search() and list() for glob results
   * that bypass the normal safePath() flow.
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
   * Symlinks that resolve inside the workspace are allowed — repos commonly
   * use in-workspace symlinks. Only symlinks that escape are rejected.
   */
  async function rejectEscapingSymlink(
    absolutePath: string,
    apiPath: string,
  ): Promise<Result<void, KoiError>> {
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

        return { ok: true, value: { content, path, size: file.size } };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to read: ${path}`, e) };
      }
    },

    async write(
      path: string,
      content: string,
      options?: FileWriteOptions,
    ): Promise<Result<FileWriteResult, KoiError>> {
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        // Always ensure parent directories exist — matches Nexus behavior
        // where writes implicitly create the path. createDirectories option
        // is kept for API compatibility but defaults to true.
        if (options?.createDirectories !== false) {
          await mkdir(dirname(p.value), { recursive: true });
        }

        if (options?.overwrite === false) {
          // Atomic exclusive create — prevents TOCTOU race between existence
          // check and write. The 'wx' flag fails with EEXIST if the file
          // already exists, making conflict detection and write a single op.
          try {
            await writeFile(p.value, content, { flag: "wx" });
            return { ok: true, value: { path, bytesWritten: Buffer.byteLength(content) } };
          } catch (wxErr: unknown) {
            if (wxErr instanceof Error && "code" in wxErr && wxErr.code === "EEXIST") {
              return { ok: false, error: err("CONFLICT", `File already exists: ${path}`) };
            }
            throw wxErr;
          }
        }

        const bytes = await Bun.write(p.value, content);
        return { ok: true, value: { path, bytesWritten: bytes } };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to write: ${path}`, e) };
      }
    },

    async edit(
      path: string,
      edits: readonly FileEdit[],
      options?: FileEditOptions,
    ): Promise<Result<FileEditResult, KoiError>> {
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        const file = Bun.file(p.value);
        if (!(await file.exists())) {
          return { ok: false, error: err("NOT_FOUND", `File not found: ${path}`) };
        }

        // Capture mtime before read for optimistic concurrency check
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
          // Verify file hasn't been modified between read and write (OCC guard).
          // Matches the ETag-based guard in @koi/fs-nexus's composite edit.
          const postStat = await stat(p.value);
          if (postStat.mtimeMs !== preMs) {
            return {
              ok: false,
              error: err("CONFLICT", `File modified during edit: ${path}`),
            };
          }
          // Write to temp file then rename for atomicity — prevents partial
          // writes from corrupting the file if the process crashes mid-write.
          const tmpPath = `${p.value}.koi-edit-${crypto.randomUUID()}`;
          await Bun.write(tmpPath, text);
          await rename(tmpPath, p.value);
        }

        return { ok: true, value: { path, hunksApplied: applied } };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to edit: ${path}`, e) };
      }
    },

    async list(path: string, options?: FileListOptions): Promise<Result<FileListResult, KoiError>> {
      const p = await safePath(path);
      if (!p.ok) return p;

      try {
        if (options?.recursive) {
          const rawGlob = options.glob ?? "**/*";
          const glob = new Bun.Glob(rawGlob.startsWith("/") ? rawGlob.slice(1) : rawGlob);
          const entries: FileListEntry[] = [];
          for await (const match of glob.scan({ cwd: p.value, dot: false })) {
            const fullPath = join(p.value, match);
            try {
              // Skip symlinks that escape the workspace root
              if (!(await isContained(fullPath))) continue;
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

          // Skip symlinks that escape the workspace — use lstat to avoid
          // following the link, then check containment if it's a symlink.
          if (entry.isSymbolicLink()) {
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
      const p = await safePath(path);
      if (!p.ok) return p;
      const symCheck = await rejectEscapingSymlink(p.value, path);
      if (!symCheck.ok) return symCheck;

      try {
        await unlink(p.value);
        return { ok: true, value: { path } };
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

    dispose(): void {
      // No-op — local filesystem needs no cleanup
    },
  };

  return backend;
}
