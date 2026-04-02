/**
 * Nexus-backed FileSystemBackend implementation.
 *
 * Each method delegates to the injected NexusTransport via JSON-RPC.
 * Path safety is enforced client-side — traversal attempts never reach Nexus.
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
import {
  computeFullPath,
  DEFAULT_BASE_PATH,
  DEFAULT_RETRIES,
  rpc,
  stripBasePath,
} from "./nexus-rpc.js";
import type { NexusFileSystemConfig } from "./types.js";
import { validateNexusFileSystemConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed FileSystemBackend for remote file operations. */
export function createNexusFileSystem(config: NexusFileSystemConfig): FileSystemBackend {
  const validated = validateNexusFileSystemConfig(config);
  if (!validated.ok) {
    throw new Error(validated.error.message, { cause: validated.error });
  }

  const rawBase = config.basePath ?? DEFAULT_BASE_PATH;
  const basePath = rawBase.startsWith("/") ? rawBase.slice(1) : rawBase;
  const transport = config.transport;
  const retries = DEFAULT_RETRIES;

  async function read(
    path: string,
    options?: FileReadOptions,
  ): Promise<Result<FileReadResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await rpc<string | FileReadResult>(
      transport,
      "read",
      {
        path: fullPathResult.value,
        ...(options?.offset !== undefined ? { offset: options.offset } : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.encoding !== undefined ? { encoding: options.encoding } : {}),
      },
      retries,
    );

    if (!result.ok) return result;

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

    const result = await rpc<null>(
      transport,
      "write",
      {
        path: fullPathResult.value,
        content,
        ...(options?.createDirectories !== undefined
          ? { createDirectories: options.createDirectories }
          : {}),
        ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
      },
      retries,
    );

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

    // Read current content
    const readResult = await rpc<string | Record<string, unknown>>(
      transport,
      "read",
      { path: fullPathResult.value },
      retries,
    );
    if (!readResult.ok) return readResult;

    // Extract content string
    const raw = readResult.value;
    let currentContent: string;
    if (typeof raw === "string") {
      currentContent = raw;
    } else if (typeof raw === "object" && raw !== null && typeof raw.content === "string") {
      currentContent = raw.content;
    } else {
      currentContent = String(raw);
    }

    // Apply hunks sequentially
    let modified = currentContent;
    let hunksApplied = 0;
    for (const hunk of edits) {
      const idx = modified.indexOf(hunk.oldText);
      if (idx === -1) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Edit hunk not found in '${path}': '${hunk.oldText.slice(0, 80)}'`,
            retryable: false,
          },
        };
      }
      const secondIdx = modified.indexOf(hunk.oldText, idx + 1);
      if (secondIdx !== -1) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Ambiguous edit hunk in '${path}': '${hunk.oldText.slice(0, 80)}' matches multiple locations`,
            retryable: false,
          },
        };
      }
      modified = modified.slice(0, idx) + hunk.newText + modified.slice(idx + hunk.oldText.length);
      hunksApplied += 1;
    }

    // Write back (unless dry run)
    if (!options?.dryRun) {
      const writeResult = await rpc<null>(
        transport,
        "write",
        { path: fullPathResult.value, content: modified },
        retries,
      );
      if (!writeResult.ok) return writeResult;
    }

    return { ok: true, value: { path, hunksApplied } };
  }

  async function list(
    path: string,
    options?: FileListOptions,
  ): Promise<Result<FileListResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await rpc<FileListResult | { readonly files: readonly string[] }>(
      transport,
      "list",
      {
        path: fullPathResult.value,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...(options?.glob !== undefined ? { glob: options.glob } : {}),
      },
      retries,
    );

    if (!result.ok) return result;

    const raw = result.value;

    // Handle flat file list from Nexus
    if ("files" in raw && Array.isArray(raw.files)) {
      const prefix = fullPathResult.value.replace(/^\/+/, "");
      const prefixWithSlash = prefix.length > 0 ? `${prefix}/` : "";
      const seen = new Set<string>();
      const entries: FileListEntry[] = [];

      for (const file of raw.files as readonly string[]) {
        const normalized = file.replace(/^\/+/, "");
        const relative =
          prefixWithSlash.length > 0 && normalized.startsWith(prefixWithSlash)
            ? normalized.slice(prefixWithSlash.length)
            : normalized;
        if (relative.length === 0) continue;
        const slashIdx = relative.indexOf("/");
        if (slashIdx === -1) {
          const hasExt = relative.lastIndexOf(".") > 0;
          const kind = hasExt ? ("file" as const) : ("directory" as const);
          if (!seen.has(relative)) {
            seen.add(relative);
            entries.push({ path: `${path === "/" ? "" : path}/${relative}`, kind });
          }
        } else {
          const dirName = relative.slice(0, slashIdx);
          if (!seen.has(dirName)) {
            seen.add(dirName);
            entries.push({ path: `${path === "/" ? "" : path}/${dirName}`, kind: "directory" });
          }
        }
      }

      return { ok: true, value: { entries, truncated: false } };
    }

    // Structured response — remap paths
    const structured = raw as FileListResult;
    const entries = structured.entries.map((entry) => ({
      ...entry,
      path: stripBasePath(basePath, entry.path),
    }));

    return { ok: true, value: { entries, truncated: structured.truncated } };
  }

  async function search(
    pattern: string,
    options?: FileSearchOptions,
  ): Promise<Result<FileSearchResult, KoiError>> {
    const searchBase = basePath.startsWith("/") ? basePath : `/${basePath}`;
    const result = await rpc<FileSearchResult>(
      transport,
      "search",
      {
        pattern,
        basePath: searchBase,
        ...(options?.glob !== undefined ? { glob: options.glob } : {}),
        ...(options?.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
        ...(options?.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
      },
      retries,
    );

    if (!result.ok) return result;

    const matches = result.value.matches.map((match) => ({
      ...match,
      path: stripBasePath(basePath, match.path),
    }));

    return { ok: true, value: { matches, truncated: result.value.truncated } };
  }

  async function del(path: string): Promise<Result<FileDeleteResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await rpc<null>(transport, "delete", { path: fullPathResult.value }, retries);
    if (!result.ok) return result;

    return { ok: true, value: { path } };
  }

  async function rename(from: string, to: string): Promise<Result<FileRenameResult, KoiError>> {
    const fullFromResult = computeFullPath(basePath, from);
    if (!fullFromResult.ok) return fullFromResult;
    const fullToResult = computeFullPath(basePath, to);
    if (!fullToResult.ok) return fullToResult;

    const result = await rpc<null>(
      transport,
      "rename",
      {
        from: fullFromResult.value,
        to: fullToResult.value,
      },
      retries,
    );

    if (!result.ok) return result;

    return { ok: true, value: { from, to } };
  }

  async function dispose(): Promise<void> {
    await transport.close();
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
