/**
 * Nexus-backed FileSystemBackend implementation.
 *
 * Each operation delegates to a Nexus JSON-RPC call via the transport layer.
 * Edit and search fall back to client-side composites when the Nexus method
 * is unavailable (METHOD_NOT_FOUND).
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
  FileSearchMatch,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { applyEditsComposite } from "./edit-composite.js";
import { METHOD_NOT_FOUND_CODE } from "./errors.js";
import { computeFullPath, stripBasePath, withSafePath } from "./paths.js";
import { createHttpTransport } from "./transport.js";
import type { NexusFileSystemConfig, NexusTransport } from "./types.js";
import { validateNexusFileSystemConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MOUNT_POINT = "fs";

// ---------------------------------------------------------------------------
// Nexus response types (match JSON-RPC shapes from Nexus server)
// ---------------------------------------------------------------------------

interface NexusReadResponse {
  readonly content: string;
  readonly metadata?: {
    readonly size?: number;
    readonly modified_at?: string;
  };
}

interface NexusWriteResponse {
  readonly bytes_written: number;
  readonly size?: number;
}

interface NexusEditResponse {
  readonly edits_applied: number;
}

interface NexusListEntry {
  readonly path: string;
  readonly size: number;
  readonly is_directory: boolean;
  readonly modified_at?: string;
}

interface NexusListResponse {
  readonly files: readonly NexusListEntry[];
  readonly has_more: boolean;
}

interface NexusGrepMatch {
  readonly path: string;
  readonly line_number: number;
  readonly line_text: string;
}

interface NexusGrepResponse {
  readonly results: readonly NexusGrepMatch[];
}

// ---------------------------------------------------------------------------
// Config extension (allows injecting transport for testing)
// ---------------------------------------------------------------------------

/** Extended config that allows injecting a transport (for testing). */
export interface NexusFileSystemFullConfig extends NexusFileSystemConfig {
  /** Injected transport — overrides HTTP transport creation. For testing only. */
  readonly transport?: NexusTransport | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed FileSystemBackend for remote file operations. */
export function createNexusFileSystem(config: NexusFileSystemFullConfig): FileSystemBackend {
  // Validate config (skip url check when transport is injected)
  if (config.transport === undefined) {
    const validated = validateNexusFileSystemConfig(config);
    if (!validated.ok) {
      throw new Error(validated.error.message, { cause: validated.error });
    }
  }

  const transport = config.transport ?? createHttpTransport(config);
  // Normalize mountPoint: strip leading slash for Nexus path convention
  const rawMount = config.mountPoint ?? DEFAULT_MOUNT_POINT;
  const basePath = rawMount.startsWith("/") ? rawMount.slice(1) : rawMount;

  // -------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------

  async function read(
    path: string,
    _options?: FileReadOptions,
  ): Promise<Result<FileReadResult, KoiError>> {
    return withSafePath(basePath, path, async (fullPath) => {
      const result = await transport.call<NexusReadResponse | string>("read", {
        path: fullPath,
        return_metadata: true,
      });
      if (!result.ok) return result;

      // Decision #6: support structured + raw string only
      const raw = result.value;
      let content: string;
      if (typeof raw === "string") {
        content = raw;
      } else {
        content = raw.content;
      }

      return {
        ok: true,
        value: {
          content,
          path,
          size: new TextEncoder().encode(content).byteLength,
        },
      };
    });
  }

  async function write(
    path: string,
    content: string,
    _options?: FileWriteOptions,
  ): Promise<Result<FileWriteResult, KoiError>> {
    return withSafePath(basePath, path, async (fullPath) => {
      const result = await transport.call<NexusWriteResponse>("write", {
        path: fullPath,
        content,
      });
      if (!result.ok) return result;

      return {
        ok: true,
        value: {
          path,
          bytesWritten: result.value.bytes_written,
        },
      };
    });
  }

  async function edit(
    path: string,
    edits: readonly FileEdit[],
    options?: FileEditOptions,
  ): Promise<Result<FileEditResult, KoiError>> {
    // Try Nexus native edit first
    const nativeResult = await withSafePath(basePath, path, async (fullPath) => {
      // Map FileEdit[] to Nexus 2-tuple format: [[old, new], ...]
      const nexusEdits = edits.map((e) => [e.oldText, e.newText]);
      return transport.call<NexusEditResponse>("edit", {
        path: fullPath,
        edits: nexusEdits,
        ...(options?.dryRun !== undefined ? { preview: options.dryRun } : {}),
      });
    });

    // If Nexus edit is available, map the response
    if (nativeResult.ok) {
      return {
        ok: true,
        value: { path, hunksApplied: nativeResult.value.edits_applied },
      };
    }

    // Fall back to composite if METHOD_NOT_FOUND
    if (
      nativeResult.error.context !== undefined &&
      nativeResult.error.context.rpcCode === METHOD_NOT_FOUND_CODE
    ) {
      return applyEditsComposite(transport, basePath, path, edits, options);
    }

    // Other errors: pass through
    return nativeResult;
  }

  async function list(
    path: string,
    options?: FileListOptions,
  ): Promise<Result<FileListResult, KoiError>> {
    return withSafePath(basePath, path, async (fullPath) => {
      const result = await transport.call<NexusListResponse>("list", {
        path: fullPath,
        details: true,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
      });
      if (!result.ok) return result;

      // Map Nexus entries to FileListEntry (decision #8: require structured)
      const entries: readonly FileListEntry[] = result.value.files.map((entry) => ({
        path: stripBasePath(basePath, entry.path),
        kind: entry.is_directory ? ("directory" as const) : ("file" as const),
        size: entry.size,
        ...(entry.modified_at !== undefined
          ? { modifiedAt: new Date(entry.modified_at).getTime() }
          : {}),
      }));

      return {
        ok: true,
        value: { entries, truncated: result.value.has_more },
      };
    });
  }

  async function search(
    pattern: string,
    options?: FileSearchOptions,
  ): Promise<Result<FileSearchResult, KoiError>> {
    // Compute search base path
    const searchBase = basePath.startsWith("/") ? basePath : `/${basePath}`;

    // Normalize glob into mounted namespace: user-relative "/subdir/*"
    // becomes "/fs/subdir/*" so the transport matches full Nexus paths.
    let filePattern: string | undefined;
    if (options?.glob !== undefined) {
      const userGlob = options.glob.startsWith("/") ? options.glob : `/${options.glob}`;
      filePattern = `${searchBase}${userGlob}`;
    }

    const result = await transport.call<NexusGrepResponse>("grep", {
      pattern,
      path: searchBase,
      ...(filePattern !== undefined ? { file_pattern: filePattern } : {}),
      ...(options?.caseSensitive === false ? { ignore_case: true } : {}),
      ...(options?.maxResults !== undefined ? { max_results: options.maxResults } : {}),
    });

    if (!result.ok) {
      // Make search unavailability explicit — don't mask it as empty results.
      // Callers must handle EXTERNAL errors, not silently assume "no matches".
      return result;
    }

    // Map Nexus grep results to FileSearchMatch
    const matches: readonly FileSearchMatch[] = result.value.results.map((m) => ({
      path: stripBasePath(basePath, m.path),
      line: m.line_number,
      text: m.line_text,
    }));

    return {
      ok: true,
      value: {
        matches,
        truncated: options?.maxResults !== undefined && matches.length >= options.maxResults,
      },
    };
  }

  async function del(path: string): Promise<Result<FileDeleteResult, KoiError>> {
    return withSafePath(basePath, path, async (fullPath) => {
      const result = await transport.call<unknown>("delete", { path: fullPath });
      if (!result.ok) return result;
      return { ok: true, value: { path } };
    });
  }

  async function rename(from: string, to: string): Promise<Result<FileRenameResult, KoiError>> {
    const fullFromResult = computeFullPath(basePath, from);
    if (!fullFromResult.ok) return fullFromResult;
    const fullToResult = computeFullPath(basePath, to);
    if (!fullToResult.ok) return fullToResult;

    const result = await transport.call<unknown>("rename", {
      old_path: fullFromResult.value,
      new_path: fullToResult.value,
    });
    if (!result.ok) return result;

    return { ok: true, value: { from, to } };
  }

  function dispose(): void {
    transport.close();
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
