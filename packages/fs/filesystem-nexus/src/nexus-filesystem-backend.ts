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
  FileListEntry,
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

const DEFAULT_BASE_PATH = "fs";

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
  // Nexus NFS expects paths with leading slash
  const result = `/${resolved.join("/")}`;

  // Ensure result stays within basePath boundary
  const normalizedBase = `/${basePath}`;
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
  // Exact match: path IS the base directory
  if (fullPath === base) {
    return "/";
  }
  // Path-boundary check: ensure base is followed by "/" to prevent
  // sibling-prefix collisions (e.g. base="/fs" must not match "/fspath/a.txt")
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  if (fullPath.startsWith(baseWithSlash)) {
    return `/${fullPath.slice(baseWithSlash.length)}`;
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

  // Normalize basePath: strip leading slash for NexusPath convention (#922)
  const rawBase = config.basePath ?? DEFAULT_BASE_PATH;
  const basePath = rawBase.startsWith("/") ? rawBase.slice(1) : rawBase;
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

    // Nexus may return:
    //   - raw string
    //   - { content: string } (FileReadResult)
    //   - { __type__: "bytes", data: "base64..." } (binary content)
    const raw = result.value;
    let content: string;
    if (typeof raw === "string") {
      content = raw;
    } else if (typeof raw === "object" && raw !== null) {
      const obj = raw as unknown as Record<string, unknown>;
      if (obj.__type__ === "bytes" && typeof obj.data === "string") {
        content = Buffer.from(obj.data, "base64").toString("utf-8");
      } else if (typeof obj.content === "string") {
        content = obj.content;
      } else {
        content = JSON.stringify(raw, null, 2);
      }
    } else {
      content = String(raw);
    }
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

    // Nexus RPC may return either:
    //   { entries: FileListEntry[], truncated } (structured)
    //   { files: string[] }                     (flat path list)
    const result = await client.rpc<FileListResult | { readonly files: readonly string[] }>(
      "list",
      {
        path: fullPathResult.value,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...(options?.glob !== undefined ? { glob: options.glob } : {}),
      },
    );

    if (!result.ok) return result;

    const raw = result.value;

    // Handle flat file list from Nexus: derive directory entries from path prefixes
    if ("files" in raw && Array.isArray(raw.files)) {
      const prefix = fullPathResult.value.replace(/^\/+/, "");
      const prefixWithSlash = prefix.length > 0 ? `${prefix}/` : "";
      const seen = new Set<string>();
      const entries: FileListEntry[] = [];

      for (const file of raw.files) {
        const normalized = file.replace(/^\/+/, "");
        const relative =
          prefixWithSlash.length > 0 && normalized.startsWith(prefixWithSlash)
            ? normalized.slice(prefixWithSlash.length)
            : normalized;
        if (relative.length === 0) continue;
        const slashIdx = relative.indexOf("/");
        if (slashIdx === -1) {
          // Immediate child — use extension heuristic to detect directories
          // Nexus list returns both files and directory names as flat strings
          const hasExt = relative.lastIndexOf(".") > 0;
          const kind = hasExt ? ("file" as const) : ("directory" as const);
          if (!seen.has(relative)) {
            seen.add(relative);
            entries.push({ path: `${path === "/" ? "" : path}/${relative}`, kind });
          }
        } else {
          // Nested path — extract top-level directory
          const dirName = relative.slice(0, slashIdx);
          if (!seen.has(dirName)) {
            seen.add(dirName);
            entries.push({ path: `${path === "/" ? "" : path}/${dirName}`, kind: "directory" });
          }
        }
      }

      return { ok: true, value: { entries, truncated: false } };
    }

    // Structured response — remap paths to strip basePath prefix
    const structured = raw as FileListResult;
    const entries = structured.entries.map((entry) => ({
      ...entry,
      path: stripBasePath(basePath, entry.path),
    }));

    return {
      ok: true,
      value: {
        entries,
        truncated: structured.truncated,
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
