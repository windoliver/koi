/**
 * NexusArtifactStore — persistent artifact storage via Nexus JSON-RPC 2.0 API.
 *
 * Each artifact is stored at `{basePath}/{id}.json` as self-contained JSON.
 * Search is implemented client-side: glob all files, read, filter, paginate.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { ArtifactClient } from "./client.js";
import { conflictError, notFoundError, validationError } from "./errors.js";
import { computeContentHash } from "./hash.js";
import type { Artifact, ArtifactId, ArtifactPage, ArtifactQuery, ArtifactUpdate } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusStoreConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Storage path prefix. Default: "/artifacts". */
  readonly basePath?: string | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface JsonRpcSuccess<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: T;
}

interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

function createRpcIdGenerator(): () => number {
  // let justified: monotonically increasing counter for JSON-RPC request IDs
  let counter = 0;
  return () => {
    counter += 1;
    return counter;
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapHttpError(status: number, message: string): KoiError {
  if (status === 404) {
    return { code: "NOT_FOUND", message, retryable: RETRYABLE_DEFAULTS.NOT_FOUND };
  }
  if (status === 403 || status === 401) {
    return { code: "PERMISSION", message, retryable: RETRYABLE_DEFAULTS.PERMISSION };
  }
  if (status === 409) {
    return { code: "CONFLICT", message, retryable: RETRYABLE_DEFAULTS.CONFLICT };
  }
  if (status === 429) {
    return { code: "RATE_LIMIT", message, retryable: RETRYABLE_DEFAULTS.RATE_LIMIT };
  }
  return { code: "EXTERNAL", message, retryable: true };
}

function mapRpcError(rpcError: { readonly code: number; readonly message: string }): KoiError {
  // JSON-RPC error codes: -32600..-32603 are protocol errors, app-specific are positive
  if (rpcError.code === -32601) {
    return {
      code: "EXTERNAL",
      message: `RPC method not found: ${rpcError.message}`,
      retryable: false,
    };
  }
  return { code: "EXTERNAL", message: rpcError.message, retryable: true };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createNexusArtifactStore(config: NexusStoreConfig): ArtifactClient {
  const basePath = config.basePath ?? "/artifacts";
  const fetchFn = config.fetch ?? globalThis.fetch;
  const nextRpcId = createRpcIdGenerator();

  async function rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: nextRpcId(), method, params };
    let response: Response;
    try {
      response = await fetchFn(config.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Nexus request failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        },
      };
    }

    if (!response.ok) {
      return { ok: false, error: mapHttpError(response.status, `Nexus HTTP ${response.status}`) };
    }

    let json: JsonRpcResponse<T>;
    try {
      json = (await response.json()) as JsonRpcResponse<T>;
    } catch {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Failed to parse Nexus response", retryable: false },
      };
    }

    if ("error" in json) {
      return { ok: false, error: mapRpcError(json.error) };
    }

    return { ok: true, value: json.result };
  }

  function artifactPath(id: string): string {
    return `${basePath}/${id}.json`;
  }

  // -----------------------------------------------------------------------
  // ArtifactClient methods
  // -----------------------------------------------------------------------

  const save = async (artifact: Artifact): Promise<Result<void, KoiError>> => {
    if (artifact.id === "") {
      return { ok: false, error: validationError("Artifact ID must not be empty") };
    }

    // Check existence first to enforce CONFLICT semantics
    const existsResult = await rpc<boolean>("exists", { path: artifactPath(artifact.id) });
    if (!existsResult.ok) return existsResult;
    if (existsResult.value) {
      return { ok: false, error: conflictError(artifact.id) };
    }

    const writeResult = await rpc<void>("write", {
      path: artifactPath(artifact.id),
      content: JSON.stringify(artifact),
    });
    if (!writeResult.ok) return writeResult;

    return { ok: true, value: undefined };
  };

  const load = async (id: ArtifactId): Promise<Result<Artifact, KoiError>> => {
    if (id === "") {
      return { ok: false, error: validationError("Artifact ID must not be empty") };
    }

    const existsResult = await rpc<boolean>("exists", { path: artifactPath(id) });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: false, error: notFoundError(id) };
    }

    const readResult = await rpc<string>("read", { path: artifactPath(id) });
    if (!readResult.ok) return readResult;

    try {
      const artifact = JSON.parse(readResult.value) as Artifact;
      return { ok: true, value: artifact };
    } catch {
      return {
        ok: false,
        error: { code: "INTERNAL", message: `Corrupt artifact data: ${id}`, retryable: false },
      };
    }
  };

  const search = async (query: ArtifactQuery): Promise<Result<ArtifactPage, KoiError>> => {
    if (query.limit !== undefined && query.limit < 0) {
      return { ok: false, error: validationError("Query limit must not be negative") };
    }
    if (query.offset !== undefined && query.offset < 0) {
      return { ok: false, error: validationError("Query offset must not be negative") };
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";

    // Glob for all artifact files
    const globResult = await rpc<readonly string[]>("glob", { pattern: `${basePath}/*.json` });
    if (!globResult.ok) return globResult;

    // Read all artifacts in parallel, then filter client-side
    const readResults = await Promise.all(
      globResult.value.map((filePath) => rpc<string>("read", { path: filePath })),
    );

    const matched: Artifact[] = [];
    for (const readResult of readResults) {
      if (!readResult.ok) continue; // Skip unreadable files

      try {
        const artifact = JSON.parse(readResult.value) as Artifact;
        if (matchesQuery(artifact, query)) {
          matched.push(artifact);
        }
      } catch {
        // Skip corrupt files
      }
    }

    // Sort
    matched.sort((a, b) => compareArtifacts(a, b, sortBy, sortOrder));

    const total = matched.length;
    const items = matched.slice(offset, offset + limit);

    return { ok: true, value: { items, total, offset, limit } };
  };

  const remove = async (id: ArtifactId): Promise<Result<void, KoiError>> => {
    if (id === "") {
      return { ok: false, error: validationError("Artifact ID must not be empty") };
    }

    const existsResult = await rpc<boolean>("exists", { path: artifactPath(id) });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: false, error: notFoundError(id) };
    }

    const deleteResult = await rpc<void>("delete", { path: artifactPath(id) });
    if (!deleteResult.ok) return deleteResult;

    return { ok: true, value: undefined };
  };

  const update = async (
    id: ArtifactId,
    updates: ArtifactUpdate,
  ): Promise<Result<void, KoiError>> => {
    if (id === "") {
      return { ok: false, error: validationError("Artifact ID must not be empty") };
    }

    // Load existing
    const loadResult = await load(id);
    if (!loadResult.ok) return loadResult;

    const existing = loadResult.value;
    const newContent = updates.content ?? existing.content;
    const contentChanged = updates.content !== undefined && updates.content !== existing.content;

    const newHash = contentChanged ? computeContentHash(newContent) : existing.contentHash;
    const newSizeBytes = contentChanged
      ? new TextEncoder().encode(newContent).byteLength
      : existing.sizeBytes;

    const updated: Artifact = {
      ...existing,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.content !== undefined ? { content: newContent } : {}),
      ...(updates.contentType !== undefined ? { contentType: updates.contentType } : {}),
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
      ...(updates.metadata !== undefined ? { metadata: updates.metadata } : {}),
      contentHash: newHash,
      sizeBytes: newSizeBytes,
      updatedAt: Date.now(),
    };

    const writeResult = await rpc<void>("write", {
      path: artifactPath(id),
      content: JSON.stringify(updated),
    });
    if (!writeResult.ok) return writeResult;

    return { ok: true, value: undefined };
  };

  const exists = async (id: ArtifactId): Promise<Result<boolean, KoiError>> => {
    if (id === "") {
      return { ok: false, error: validationError("Artifact ID must not be empty") };
    }

    return rpc<boolean>("exists", { path: artifactPath(id) });
  };

  return { save, load, search, remove, update, exists };
}

// ---------------------------------------------------------------------------
// Shared filtering (same as memory-store)
// ---------------------------------------------------------------------------

function matchesQuery(artifact: Artifact, query: ArtifactQuery): boolean {
  if (query.tags !== undefined && query.tags.length > 0) {
    for (const tag of query.tags) {
      if (!artifact.tags.includes(tag)) {
        return false;
      }
    }
  }
  if (query.createdBy !== undefined && artifact.createdBy !== query.createdBy) {
    return false;
  }
  if (query.contentType !== undefined && artifact.contentType !== query.contentType) {
    return false;
  }
  if (query.textSearch !== undefined && query.textSearch !== "") {
    const needle = query.textSearch.toLowerCase();
    const haystack = `${artifact.name} ${artifact.description}`.toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }
  return true;
}

function compareArtifacts(
  a: Artifact,
  b: Artifact,
  sortBy: "createdAt" | "updatedAt" | "name",
  sortOrder: "asc" | "desc",
): number {
  let cmp: number;
  if (sortBy === "name") {
    cmp = a.name.localeCompare(b.name);
  } else {
    cmp = a[sortBy] - b[sortBy];
  }
  return sortOrder === "asc" ? cmp : -cmp;
}
