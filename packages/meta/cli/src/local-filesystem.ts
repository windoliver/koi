/**
 * createLocalFileSystem — minimal local filesystem backend for the admin panel.
 *
 * Scoped to a root directory with path traversal prevention.
 * Used by CLI commands to provide file browsing in the admin panel.
 */

import { mkdir, readdir, stat, unlink } from "node:fs/promises";
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

/** Normalize a path to forward slashes for consistent API responses. */
function toApiPath(p: string): string {
  return sep === "\\" ? p.replaceAll("\\", "/") : p;
}

export function createLocalFileSystem(rootPath: string): FileSystemBackend {
  const root = resolve(rootPath);

  // Append path separator so /Users/taofeng/koi doesn't match /Users/taofeng/koi2
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  /** Resolve and validate that a path is within the workspace root. */
  function safePath(path: string): Result<string, KoiError> {
    const normalized = path.startsWith("/") ? path.slice(1) : path;
    const resolved = resolve(root, normalized);
    // Allow exact root or any child path (prefix includes trailing slash)
    if (resolved !== root && !resolved.startsWith(rootPrefix)) {
      return { ok: false, error: err("PERMISSION", `Path outside workspace: ${path}`) };
    }
    return { ok: true, value: resolved };
  }

  const backend: FileSystemBackend = {
    name: "local",

    async read(path: string, options?: FileReadOptions): Promise<Result<FileReadResult, KoiError>> {
      const p = safePath(path);
      if (!p.ok) return p;

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
      const p = safePath(path);
      if (!p.ok) return p;

      try {
        if (options?.createDirectories) {
          await mkdir(dirname(p.value), { recursive: true });
        }

        if (options?.overwrite === false) {
          const file = Bun.file(p.value);
          if (await file.exists()) {
            return { ok: false, error: err("CONFLICT", `File already exists: ${path}`) };
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
      const p = safePath(path);
      if (!p.ok) return p;

      try {
        const file = Bun.file(p.value);
        if (!(await file.exists())) {
          return { ok: false, error: err("NOT_FOUND", `File not found: ${path}`) };
        }

        let text = await file.text();
        let applied = 0;
        for (const edit of edits) {
          if (text.includes(edit.oldText)) {
            text = text.replace(edit.oldText, edit.newText);
            applied++;
          }
        }

        if (options?.dryRun !== true) {
          await Bun.write(p.value, text);
        }

        return { ok: true, value: { path, hunksApplied: applied } };
      } catch (e: unknown) {
        return { ok: false, error: err("INTERNAL", `Failed to edit: ${path}`, e) };
      }
    },

    async list(path: string, options?: FileListOptions): Promise<Result<FileListResult, KoiError>> {
      const p = safePath(path);
      if (!p.ok) return p;

      try {
        if (options?.glob !== undefined && options.recursive) {
          const glob = new Bun.Glob(options.glob);
          const entries: FileListEntry[] = [];
          for await (const match of glob.scan({ cwd: p.value, dot: false })) {
            const fullPath = join(p.value, match);
            try {
              const s = await stat(fullPath);
              entries.push({
                path: toApiPath(join(path, match)),
                kind: s.isDirectory() ? "directory" : "file",
                ...(s.isFile() ? { size: s.size } : {}),
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
          const kind = entry.isDirectory()
            ? ("directory" as const)
            : entry.isSymbolicLink()
              ? ("symlink" as const)
              : ("file" as const);

          let size: number | undefined;
          if (kind === "file") {
            try {
              const s = await stat(join(p.value, entry.name));
              size = s.size;
            } catch {
              /* skip */
            }
          }
          entries.push({
            path: toApiPath(join(path, entry.name)),
            kind,
            ...(size !== undefined ? { size } : {}),
          });
        }
        return { ok: true, value: { entries, truncated: false } };
      } catch (e: unknown) {
        return { ok: false, error: err("NOT_FOUND", `Directory not found: ${path}`, e) };
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
        const glob = new Bun.Glob(options?.glob ?? "**/*");
        const matches: FileSearchMatch[] = [];

        for await (const filePath of glob.scan({ cwd: root, dot: false })) {
          if (matches.length >= maxResults) break;
          const fullPath = join(root, filePath);
          try {
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
      const p = safePath(path);
      if (!p.ok) return p;

      try {
        await unlink(p.value);
        return { ok: true, value: { path } };
      } catch (e: unknown) {
        return { ok: false, error: err("NOT_FOUND", `File not found: ${path}`, e) };
      }
    },
  };

  return backend;
}
