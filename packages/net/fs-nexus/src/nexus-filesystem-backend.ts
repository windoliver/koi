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
  isWithinBasePath,
  normalizeServerPath,
  rpcMutate,
  rpcRead,
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

  // Use the validated config — basePath is already canonicalized (decoded,
  // backslash-normalized, leading-slash-stripped) by validateNexusFileSystemConfig.
  const basePath = validated.value.basePath ?? DEFAULT_BASE_PATH;
  const transport = validated.value.transport;

  /** Decode a Nexus read response into a content string. Handles raw string,
   *  { content: string }, and { __type__: "bytes", data: base64 } forms.
   *  Returns EXTERNAL error for unrecognized shapes instead of coercing. */
  function decodeReadResponse(raw: unknown): Result<string, KoiError> {
    if (typeof raw === "string") {
      return { ok: true, value: raw };
    }
    if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      if (obj.__type__ === "bytes" && typeof obj.data === "string") {
        return { ok: true, value: Buffer.from(obj.data, "base64").toString("utf-8") };
      }
      if (typeof obj.content === "string") {
        return { ok: true, value: obj.content };
      }
    }
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Nexus returned unrecognized read response shape: ${typeof raw}`,
        retryable: false,
      },
    };
  }
  const retries = DEFAULT_RETRIES;

  // Lazy-cached CAS capability check via a dedicated non-mutating RPC.
  // Only confirmed results (true/false) are cached. Transport failures
  // (timeouts, connection errors) leave the cache unset so the next
  // edit() can re-probe after the server recovers.
  let casCapability: boolean | undefined;

  async function checkCasSupport(): Promise<Result<boolean, KoiError>> {
    if (casCapability !== undefined) {
      return { ok: true, value: casCapability };
    }

    const result = await rpcRead<{ readonly cas?: boolean } | null>(
      transport,
      "capabilities",
      {},
      retries,
    );

    if (!result.ok) {
      // Transport failure — do NOT cache, allow re-probe on next edit
      return result;
    }

    // Only cache explicit boolean capability values. Malformed responses
    // (null, missing cas field, non-boolean cas) are treated as errors
    // and NOT cached, so the next edit() re-probes after recovery.
    const raw = result.value;
    if (raw === null || typeof raw !== "object") {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Nexus capabilities response is malformed: expected object",
          retryable: false,
        },
      };
    }
    if (typeof raw.cas !== "boolean") {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Nexus capabilities response has invalid 'cas' field: expected boolean, got ${typeof raw.cas}`,
          retryable: false,
        },
      };
    }
    casCapability = raw.cas;
    return { ok: true, value: raw.cas };
  }

  async function read(
    path: string,
    options?: FileReadOptions,
  ): Promise<Result<FileReadResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await rpcRead<string | FileReadResult>(
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

    const decoded = decodeReadResponse(result.value);
    if (!decoded.ok) return decoded;
    const content = decoded.value;

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

    const result = await rpcMutate<null>(transport, "write", {
      path: fullPathResult.value,
      content,
      createDirectories: options?.createDirectories ?? false,
      overwrite: options?.overwrite ?? false,
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

    // Read current content
    const readResult = await rpcRead<string | Record<string, unknown>>(
      transport,
      "read",
      { path: fullPathResult.value },
      retries,
    );
    if (!readResult.ok) return readResult;

    // Decode content using shared decoder (handles string, { content }, bytes)
    const decoded = decodeReadResponse(readResult.value);
    if (!decoded.ok) return decoded;
    const currentContent = decoded.value;

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
      // Negotiate CAS support via the non-mutating "capabilities" RPC.
      // Confirmed results are cached; transport failures allow re-probe.
      const casResult = await checkCasSupport();
      if (!casResult.ok) return casResult;
      if (!casResult.value) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Nexus server does not support CAS — edit of '${path}' blocked to prevent unsafe concurrent writes`,
            retryable: false,
            context: { path },
          },
        };
      }

      // Server confirmed CAS capability — compute content hash and send
      // a conditional write. The server contract guarantees it will reject
      // the write atomically if the hash does not match.
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(currentContent));
      const hashArray = new Uint8Array(hashBuffer);
      const expectedContentHash = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Require the write response to confirm CAS enforcement. This is the
      // second defense layer: the capabilities probe gates entry, but the
      // write-response check catches load-balanced or rolling-deploy scenarios
      // where the write lands on a different (non-CAS) node than the probe.
      // Reporting failure here is safe — if the server enforced CAS, the write
      // was atomic and correct. If it didn't, the caller must treat the edit
      // as uncertain and re-read.
      const writeResult = await rpcMutate<{ readonly casEnforced?: boolean } | null>(
        transport,
        "write",
        {
          path: fullPathResult.value,
          content: modified,
          expectedContentHash,
          overwrite: true, // edit always targets existing files
        },
      );
      if (!writeResult.ok) return writeResult;

      const casConfirmed =
        writeResult.value !== null &&
        typeof writeResult.value === "object" &&
        writeResult.value.casEnforced === true;
      if (!casConfirmed) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Edit write for '${path}' was not confirmed as CAS-enforced — the file may have been modified without conflict protection (possible load-balanced routing to non-CAS node)`,
            retryable: false,
            context: { path, expectedContentHash },
          },
        };
      }
    }

    return { ok: true, value: { path, hunksApplied } };
  }

  async function list(
    path: string,
    options?: FileListOptions,
  ): Promise<Result<FileListResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await rpcRead<FileListResult | { readonly files: readonly string[] }>(
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

    // Validate response shape — Nexus must return a non-null object
    if (raw === null || raw === undefined || typeof raw !== "object") {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Nexus returned invalid list response: expected object, got ${typeof raw}`,
          retryable: false,
        },
      };
    }

    // Handle flat file list from Nexus
    if ("files" in raw && Array.isArray(raw.files)) {
      const prefix = fullPathResult.value.replace(/^\/+/, "");
      const prefixWithSlash = prefix.length > 0 ? `${prefix}/` : "";
      const seen = new Set<string>();
      const entries: FileListEntry[] = [];

      const isRecursive = options?.recursive === true;
      for (const file of raw.files as readonly string[]) {
        const normalized = file.replace(/^\/+/, "");
        // Validate: only process entries that belong under the requested prefix.
        // Drop out-of-scope entries to prevent leaking unrelated paths from a
        // misbehaving server or version skew.
        if (prefixWithSlash.length > 0 && !normalized.startsWith(prefixWithSlash)) {
          continue;
        }
        const relative =
          prefixWithSlash.length > 0 ? normalized.slice(prefixWithSlash.length) : normalized;
        if (relative.length === 0) continue;
        const slashIdx = relative.indexOf("/");
        if (slashIdx === -1) {
          // Immediate child — conservatively treat as file (no metadata in
          // flat lists to distinguish files from extensionless directories)
          if (!seen.has(relative)) {
            seen.add(relative);
            entries.push({ path: `${path === "/" ? "" : path}/${relative}`, kind: "file" });
          }
        } else if (isRecursive) {
          // Recursive mode: emit the full descendant file entry
          if (!seen.has(relative)) {
            seen.add(relative);
            entries.push({ path: `${path === "/" ? "" : path}/${relative}`, kind: "file" });
          }
        } else {
          // Non-recursive: collapse nested paths to top-level directory
          const dirName = relative.slice(0, slashIdx);
          if (!seen.has(dirName)) {
            seen.add(dirName);
            entries.push({ path: `${path === "/" ? "" : path}/${dirName}`, kind: "directory" });
          }
        }
      }

      // Preserve truncation from flat response if present; fail closed
      // (assume truncated) if the flat shape cannot express completeness.
      const flatObj = raw as Record<string, unknown>;
      const flatTruncated = typeof flatObj.truncated === "boolean" ? flatObj.truncated : true;
      return { ok: true, value: { entries, truncated: flatTruncated } };
    }

    // Structured response — validate shape, filter to scope, remap paths
    const structured = raw as Record<string, unknown>;
    if (!Array.isArray(structured.entries)) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Nexus returned invalid list response: missing 'entries' array",
          retryable: false,
        },
      };
    }
    const rawEntries = (structured as unknown as FileListResult).entries;
    // Validate each element has a string path before processing
    for (const entry of rawEntries) {
      if (typeof entry?.path !== "string") {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "Nexus returned list entry with missing or non-string 'path'",
            retryable: false,
          },
        };
      }
    }
    // Filter to the requested path (not just basePath) — prevents sibling
    // directories under the same base from leaking into the result.
    const requestedPrefix = fullPathResult.value;
    const entries = rawEntries
      .filter((entry) => {
        const normalized = normalizeServerPath(entry.path);
        // Must be within basePath AND within the requested subtree
        if (!isWithinBasePath(basePath, normalized)) return false;
        if (normalized !== requestedPrefix && !normalized.startsWith(`${requestedPrefix}/`)) {
          return false;
        }
        return true;
      })
      .map((entry) => ({
        ...entry,
        path: stripBasePath(basePath, normalizeServerPath(entry.path)),
      }));

    const truncated = typeof structured.truncated === "boolean" ? structured.truncated : false;
    return { ok: true, value: { entries, truncated } };
  }

  async function search(
    pattern: string,
    options?: FileSearchOptions,
  ): Promise<Result<FileSearchResult, KoiError>> {
    const searchBase = basePath.startsWith("/") ? basePath : `/${basePath}`;
    const result = await rpcRead<FileSearchResult>(
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

    // Validate response shape
    const searchRaw = result.value as unknown;
    if (
      searchRaw === null ||
      searchRaw === undefined ||
      typeof searchRaw !== "object" ||
      !Array.isArray((searchRaw as Record<string, unknown>).matches)
    ) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Nexus returned invalid search response: missing 'matches' array",
          retryable: false,
        },
      };
    }

    const validated = searchRaw as FileSearchResult;
    // Validate each match has a string path before processing
    for (const match of validated.matches) {
      if (typeof match?.path !== "string") {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "Nexus returned search match with missing or non-string 'path'",
            retryable: false,
          },
        };
      }
    }
    const matches = validated.matches
      .filter((match) => {
        const normalized = normalizeServerPath(match.path);
        return isWithinBasePath(basePath, normalized);
      })
      .map((match) => ({
        ...match,
        path: stripBasePath(basePath, normalizeServerPath(match.path)),
      }));

    const searchTruncated = typeof validated.truncated === "boolean" ? validated.truncated : false;
    return { ok: true, value: { matches, truncated: searchTruncated } };
  }

  async function del(path: string): Promise<Result<FileDeleteResult, KoiError>> {
    const fullPathResult = computeFullPath(basePath, path);
    if (!fullPathResult.ok) return fullPathResult;

    const result = await rpcMutate<null>(transport, "delete", { path: fullPathResult.value });
    if (!result.ok) return result;

    return { ok: true, value: { path } };
  }

  async function rename(from: string, to: string): Promise<Result<FileRenameResult, KoiError>> {
    const fullFromResult = computeFullPath(basePath, from);
    if (!fullFromResult.ok) return fullFromResult;
    const fullToResult = computeFullPath(basePath, to);
    if (!fullToResult.ok) return fullToResult;

    const result = await rpcMutate<null>(transport, "rename", {
      from: fullFromResult.value,
      to: fullToResult.value,
    });

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
