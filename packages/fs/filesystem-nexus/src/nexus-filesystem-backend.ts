/**
 * Nexus-backed FileSystemBackend implementation.
 *
 * Each method delegates to `client.rpc()` with the appropriate method name.
 * Error mapping is handled by NexusClient — RPC/HTTP errors become KoiError.
 *
 * Pattern: same shape as createNexusForgeStore in @koi/store-nexus.
 */

import type {
  FileDeleteResult,
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileRenameResult,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { NexusFileSystemConfig } from "./types.js";
import { validateNexusFileSystemConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = "/fs";

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

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
function computeFullPath(basePath: string, userPath: string): Result<string, KoiError> {
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
  const normalized = decodeURIComponent(userPath.replace(/\\/g, "/"));

  // Strip leading slash to avoid double-slash when joining
  const normalizedUser = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const joined = `${basePath}/${normalizedUser}`;

  // Resolve ".." segments immutably
  const parts = joined.split("/");
  const resolved = parts.reduce<readonly string[]>((acc, part) => {
    if (part === "..") return acc.slice(0, -1);
    if (part !== "" && part !== ".") return acc.concat(part);
    return acc;
  }, []);
  const result = `/${resolved.join("/")}`;

  // Ensure result stays within basePath boundary
  const baseWithSlash = basePath.endsWith("/") ? basePath : `${basePath}/`;
  if (result !== basePath && !result.startsWith(baseWithSlash)) {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map EXTERNAL errors (Nexus "Not found") to NOT_FOUND. */
function mapNotFoundError<T>(result: {
  readonly ok: false;
  readonly error: KoiError;
}): Result<T, KoiError> {
  if (
    result.error.code === "EXTERNAL" &&
    result.error.message.toLowerCase().includes("not found")
  ) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: result.error.message,
        retryable: false,
      },
    };
  }
  return result;
}

/** Strip basePath prefix from a full path, returning the user-relative path. */
function stripBasePath(base: string, fullPath: string): string {
  if (fullPath.startsWith(base)) {
    const relative = fullPath.slice(base.length);
    return relative.startsWith("/") ? relative : `/${relative}`;
  }
  return fullPath;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed FileSystemBackend for remote file operations. */
export function createNexusFileSystem(config: NexusFileSystemConfig): FileSystemBackend {
  const validated = validateNexusFileSystemConfig(config);
  if (!validated.ok) {
    throw new Error(validated.error.message, { cause: validated.error });
  }

  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const client = config.client;

  async function read(
    path: string,
    options?: FileReadOptions,
  ): Promise<Result<FileReadResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await client.rpc<string | FileReadResult>("read", {
      path: fullPathResult.value,
      ...(options?.offset !== undefined ? { offset: options.offset } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.encoding !== undefined ? { encoding: options.encoding } : {}),
    });

    if (!result.ok) {
      return mapNotFoundError(result);
    }

    // Nexus may return raw content string or a structured FileReadResult
    const content = typeof result.value === "string" ? result.value : result.value.content;
    return {
      ok: true,
      value: {
        content,
        path,
        size: new TextEncoder().encode(content).byteLength,
      },
    };
  }

  async function write(
    path: string,
    content: string,
    options?: FileWriteOptions,
  ): Promise<Result<FileWriteResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await client.rpc<null>("write", {
      path: fullPathResult.value,
      content,
      ...(options?.createDirectories !== undefined
        ? { createDirectories: options.createDirectories }
        : {}),
      ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
    });

    if (!result.ok) return result;

    return {
      ok: true,
      value: {
        path,
        bytesWritten: new TextEncoder().encode(content).byteLength,
      },
    };
  }

  async function edit(
    path: string,
    edits: readonly FileEdit[],
    options?: FileEditOptions,
  ): Promise<Result<FileEditResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await client.rpc<FileEditResult>("edit", {
      path: fullPathResult.value,
      edits,
      ...(options?.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    });

    if (!result.ok) {
      return mapNotFoundError(result);
    }

    return {
      ok: true,
      value: {
        path,
        hunksApplied: result.value.hunksApplied,
      },
    };
  }

  async function list(
    path: string,
    options?: FileListOptions,
  ): Promise<Result<FileListResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await client.rpc<FileListResult>("list", {
      path: fullPathResult.value,
      ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
      ...(options?.glob !== undefined ? { glob: options.glob } : {}),
    });

    if (!result.ok) return result;

    // Remap paths: strip basePath prefix so callers see user-relative paths
    const entries = result.value.entries.map((entry) => ({
      ...entry,
      path: stripBasePath(basePath, entry.path),
    }));

    return {
      ok: true,
      value: {
        entries,
        truncated: result.value.truncated,
      },
    };
  }

  async function search(
    pattern: string,
    options?: FileSearchOptions,
  ): Promise<Result<FileSearchResult, KoiError>> {
    const result = await client.rpc<FileSearchResult>("search", {
      pattern,
      basePath,
      ...(options?.glob !== undefined ? { glob: options.glob } : {}),
      ...(options?.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
      ...(options?.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
    });

    if (!result.ok) return result;

    // Remap paths: strip basePath prefix
    const matches = result.value.matches.map((match) => ({
      ...match,
      path: stripBasePath(basePath, match.path),
    }));

    return {
      ok: true,
      value: {
        matches,
        truncated: result.value.truncated,
      },
    };
  }

  async function del(path: string): Promise<Result<FileDeleteResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await client.rpc<null>("delete", { path: fullPathResult.value });

    if (!result.ok) return result;

    return { ok: true, value: { path } };
  }

  async function rename(from: string, to: string): Promise<Result<FileRenameResult, KoiError>> {
    const fullFromResult = computeFullPath(basePath, from);
    if (!fullFromResult.ok) return fullFromResult;
    const fullToResult = computeFullPath(basePath, to);
    if (!fullToResult.ok) return fullToResult;

    const result = await client.rpc<FileRenameResult>("rename", {
      from: fullFromResult.value,
      to: fullToResult.value,
    });

    if (!result.ok) return result;

    return { ok: true, value: { from, to } };
  }

  function dispose(): void {
    // No-op — NexusClient has no connection state to clean up
  }

  return {
    name: "nexus",
    read,
    write,
    edit,
    list,
    search,
    delete: del,
    rename,
    dispose,
  };
}
