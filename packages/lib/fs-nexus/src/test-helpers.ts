/**
 * Fake Nexus transport for unit tests.
 *
 * In-memory filesystem store that handles all Nexus RPC methods.
 * Supports error injection for testing error paths.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { applyEdit } from "@koi/edit-match";
import type { NexusTransport } from "./types.js";

// ---------------------------------------------------------------------------
// File entry
// ---------------------------------------------------------------------------

interface FakeFile {
  content: string;
  readonly isDirectory: boolean;
  readonly createdAt: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Error injection
// ---------------------------------------------------------------------------

export interface FakeTransportOptions {
  /** Force a specific RPC method to fail with a JSON-RPC error code. */
  readonly failMethod?: string | undefined;
  readonly failCode?: number | undefined;
  readonly failMessage?: string | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const METHOD_NOT_FOUND = -32601;
const FILE_NOT_FOUND = -32000;

/**
 * Simple glob matching for fake transport (supports * and ** patterns).
 * Matches against both the full path and the path suffix to handle
 * globs that don't include the basePath prefix.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex: * matches anything except /, ** matches anything
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  const regex = new RegExp(`${escaped}$`);
  return regex.test(filePath);
}

export function createFakeNexusTransport(options?: FakeTransportOptions): NexusTransport {
  const files = new Map<string, FakeFile>();
  let closed = false;

  function rpcError(code: number, message: string): Result<never, KoiError> {
    const koiCode =
      code === FILE_NOT_FOUND
        ? "NOT_FOUND"
        : code === -32002
          ? "VALIDATION"
          : code === METHOD_NOT_FOUND
            ? "EXTERNAL"
            : "INTERNAL";
    return {
      ok: false,
      error: {
        code: koiCode,
        message,
        retryable: RETRYABLE_DEFAULTS[koiCode],
        context: { rpcCode: code },
      },
    };
  }

  function getFile(path: string): FakeFile | undefined {
    return files.get(path);
  }

  function ensureParents(path: string): void {
    const parts = path.split("/").filter((p) => p.length > 0);
    let current = "";
    // Create all parent directories (skip last segment which is the file)
    for (let i = 0; i < parts.length - 1; i++) {
      current = `${current}/${parts[i] ?? ""}`;
      if (!files.has(current)) {
        files.set(current, {
          content: "",
          isDirectory: true,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        });
      }
    }
  }

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    if (closed) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Transport closed", retryable: false },
      };
    }

    // Error injection
    if (options?.failMethod === method && options.failCode !== undefined) {
      return rpcError(options.failCode, options.failMessage ?? "injected error");
    }

    const path = params.path as string | undefined;

    switch (method) {
      case "read": {
        if (path === undefined) return rpcError(-32002, "path required");
        const file = getFile(path);
        if (file === undefined) return rpcError(FILE_NOT_FOUND, `not found: ${path}`);
        if (file.isDirectory) return rpcError(-32002, `is a directory: ${path}`);
        return {
          ok: true,
          value: {
            content: file.content,
            metadata: {
              path,
              size: new TextEncoder().encode(file.content).byteLength,
              is_directory: false,
              modified_at: file.modifiedAt,
            },
          } as T,
        };
      }

      case "write": {
        if (path === undefined) return rpcError(-32002, "path required");
        const content = (params.content as string | undefined) ?? "";
        ensureParents(path);
        const existing = files.get(path);
        if (existing !== undefined) {
          existing.content = content;
          existing.modifiedAt = new Date().toISOString();
        } else {
          files.set(path, {
            content,
            isDirectory: false,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
          });
        }
        const size = new TextEncoder().encode(content).byteLength;
        return {
          ok: true,
          value: { bytes_written: size, size } as T,
        };
      }

      case "edit": {
        if (path === undefined) return rpcError(-32002, "path required");
        const file = getFile(path);
        if (file === undefined) return rpcError(FILE_NOT_FOUND, `not found: ${path}`);
        const edits = params.edits as readonly [string, string][];
        const preview = params.preview as boolean | undefined;

        let workingContent = file.content;
        let applied = 0;
        for (const [oldText, newText] of edits) {
          const result = applyEdit(workingContent, oldText, newText);
          if (result === undefined) {
            return rpcError(-32005, `edit hunk not found: "${oldText}"`);
          }
          workingContent = result.content;
          applied++;
        }

        if (preview !== true) {
          file.content = workingContent;
          file.modifiedAt = new Date().toISOString();
        }
        return { ok: true, value: { edits_applied: applied } as T };
      }

      case "list": {
        const listPath = path ?? "/";
        const recursive = params.recursive as boolean | undefined;
        const entries: Array<{
          readonly path: string;
          readonly size: number;
          readonly is_directory: boolean;
          readonly modified_at: string;
        }> = [];

        const prefix = listPath === "/" ? "/" : `${listPath}/`;
        for (const [filePath, file] of files) {
          if (!filePath.startsWith(prefix) && filePath !== listPath) continue;
          const relative = filePath.slice(prefix.length);
          if (!recursive && relative.includes("/")) continue;
          if (filePath === listPath) continue; // Skip the directory itself
          entries.push({
            path: filePath,
            size: new TextEncoder().encode(file.content).byteLength,
            is_directory: file.isDirectory,
            modified_at: file.modifiedAt,
          });
        }

        return {
          ok: true,
          value: { files: entries, has_more: false } as T,
        };
      }

      case "grep": {
        const pattern = params.pattern as string;
        const searchPath = (params.path as string | undefined) ?? "/";
        const ignoreCase = params.ignore_case as boolean | undefined;
        const maxResults = (params.max_results as number | undefined) ?? 100;
        const filePattern = params.file_pattern as string | undefined;

        const flags = ignoreCase === true ? "gi" : "g";
        const regex = new RegExp(pattern, flags);
        const results: Array<{
          readonly path: string;
          readonly line_number: number;
          readonly line_text: string;
        }> = [];

        const prefix = searchPath === "/" ? "/" : `${searchPath}/`;
        for (const [filePath, file] of files) {
          if (file.isDirectory) continue;
          if (!filePath.startsWith(prefix) && filePath !== searchPath) continue;
          if (filePattern !== undefined && !matchGlob(filePath, filePattern)) continue;
          if (results.length >= maxResults) break;

          const lines = file.content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line !== undefined && regex.test(line)) {
              results.push({ path: filePath, line_number: i + 1, line_text: line });
              regex.lastIndex = 0;
              if (results.length >= maxResults) break;
            }
          }
        }

        return { ok: true, value: { results } as T };
      }

      case "delete": {
        if (path === undefined) return rpcError(-32002, "path required");
        if (!files.has(path)) return rpcError(FILE_NOT_FOUND, `not found: ${path}`);
        files.delete(path);
        return { ok: true, value: { deleted: true } as T };
      }

      case "rename": {
        const oldPath = params.old_path as string | undefined;
        const newPath = params.new_path as string | undefined;
        if (oldPath === undefined || newPath === undefined) {
          return rpcError(-32002, "old_path and new_path required");
        }
        const file = files.get(oldPath);
        if (file === undefined) return rpcError(FILE_NOT_FOUND, `not found: ${oldPath}`);
        files.delete(oldPath);
        files.set(newPath, file);
        return { ok: true, value: { renamed: true } as T };
      }

      default:
        return rpcError(METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  return {
    call,
    close(): void {
      closed = true;
    },
  };
}
