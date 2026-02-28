/**
 * NexusArtifactStore — persistent artifact storage via Nexus JSON-RPC 2.0 API.
 *
 * Each artifact is stored at `{basePath}/{id}.json` as self-contained JSON.
 * Search is implemented client-side: glob all files, read, filter, paginate.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
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
// Implementation
// ---------------------------------------------------------------------------

export function createNexusArtifactStore(config: NexusStoreConfig): ArtifactClient {
  const basePath = config.basePath ?? "/artifacts";
  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  async function rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    return client.rpc<T>(method, params);
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
