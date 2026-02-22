/**
 * InMemoryArtifactStore — Map-based store for tests and development.
 * No persistence across restarts.
 */

import type { KoiError, Result } from "@koi/core";
import type { ArtifactClient } from "./client.js";
import { conflictError, notFoundError, validationError } from "./errors.js";
import { computeContentHash } from "./hash.js";
import type { Artifact, ArtifactId, ArtifactPage, ArtifactQuery, ArtifactUpdate } from "./types.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateId(id: ArtifactId): Result<void, KoiError> {
  if (id === "") {
    return { ok: false, error: validationError("Artifact ID must not be empty") };
  }
  return { ok: true, value: undefined };
}

function validateQuery(query: ArtifactQuery): Result<void, KoiError> {
  if (query.limit !== undefined && query.limit < 0) {
    return { ok: false, error: validationError("Query limit must not be negative") };
  }
  if (query.offset !== undefined && query.offset < 0) {
    return { ok: false, error: validationError("Query offset must not be negative") };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Filtering & sorting
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemoryArtifactStore(): ArtifactClient {
  const store = new Map<string, Artifact>();

  const save = async (artifact: Artifact): Promise<Result<void, KoiError>> => {
    const idCheck = validateId(artifact.id);
    if (!idCheck.ok) return idCheck;

    if (store.has(artifact.id)) {
      return { ok: false, error: conflictError(artifact.id) };
    }
    store.set(artifact.id, artifact);
    return { ok: true, value: undefined };
  };

  const load = async (id: ArtifactId): Promise<Result<Artifact, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    const artifact = store.get(id);
    if (artifact === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    return { ok: true, value: artifact };
  };

  const search = async (query: ArtifactQuery): Promise<Result<ArtifactPage, KoiError>> => {
    const queryCheck = validateQuery(query);
    if (!queryCheck.ok) return queryCheck;

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";

    const matched: Artifact[] = [];
    for (const artifact of store.values()) {
      if (matchesQuery(artifact, query)) {
        matched.push(artifact);
      }
    }

    matched.sort((a, b) => compareArtifacts(a, b, sortBy, sortOrder));

    const total = matched.length;
    const items = matched.slice(offset, offset + limit);

    return { ok: true, value: { items, total, offset, limit } };
  };

  const remove = async (id: ArtifactId): Promise<Result<void, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    if (!store.has(id)) {
      return { ok: false, error: notFoundError(id) };
    }
    store.delete(id);
    return { ok: true, value: undefined };
  };

  const update = async (
    id: ArtifactId,
    updates: ArtifactUpdate,
  ): Promise<Result<void, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    const existing = store.get(id);
    if (existing === undefined) {
      return { ok: false, error: notFoundError(id) };
    }

    const newContent = updates.content ?? existing.content;
    const contentChanged = updates.content !== undefined && updates.content !== existing.content;

    const newHash = contentChanged ? await computeContentHash(newContent) : existing.contentHash;
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

    store.set(id, updated);
    return { ok: true, value: undefined };
  };

  const exists = async (id: ArtifactId): Promise<Result<boolean, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    return { ok: true, value: store.has(id) };
  };

  return { save, load, search, remove, update, exists };
}
