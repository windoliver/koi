/**
 * InMemoryForgeStore — simple Map-based store for tests and development.
 * No eviction, no persistence across restarts.
 *
 * Features:
 * - Content integrity verification on load (recomputes BrickId from content)
 * - Store-level version tracking for optimistic locking on update
 */

import type {
  BrickArtifact,
  BrickId,
  BrickSummary,
  BrickUpdate,
  ForgeQuery,
  ForgeScope,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { conflict, notFound } from "@koi/core";
import { computeBrickId, isBrickId } from "@koi/hash";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  matchesBrickQuery,
  sortBricks,
} from "@koi/validation";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

function integrityError(id: BrickId, expectedId: BrickId, actualId: BrickId): KoiError {
  return {
    code: "VALIDATION",
    message: `Content integrity check failed for brick ${id}: expected ${expectedId}, got ${actualId}`,
    retryable: false,
    context: { brickId: id, expectedId, actualId },
  };
}

function versionConflictError(id: BrickId, expected: number, actual: number): KoiError {
  return conflict(
    id,
    `Version conflict on brick ${id}: expected version ${String(expected)}, current version ${String(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// Content integrity helpers
// ---------------------------------------------------------------------------

/**
 * Extract the primary content string from a brick for BrickId recomputation.
 * Mirrors the logic in @koi/forge-integrity/brick-content.ts but avoids
 * the L2→L2 dependency by inlining the mapping.
 */
function extractContent(brick: BrickArtifact): string {
  switch (brick.kind) {
    case "tool":
    case "middleware":
    case "channel":
      return brick.implementation;
    case "skill":
      return brick.content;
    case "agent":
      return brick.manifestYaml;
    case "composite":
      return brick.steps.map((s) => s.brickId).join(",");
  }
}

/**
 * Verify that a brick's content matches its content-addressed ID.
 * Returns the recomputed BrickId, or undefined if the check passes.
 */
function verifyContentIntegrity(
  brick: BrickArtifact,
): { readonly valid: true } | { readonly valid: false; readonly recomputedId: BrickId } {
  const content = extractContent(brick);
  const recomputedId = computeBrickId(brick.kind, content, brick.files);
  if (recomputedId === brick.id) {
    return { valid: true };
  }
  return { valid: false, recomputedId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemoryForgeStore(): ForgeStore {
  const bricks = new Map<BrickId, BrickArtifact>();
  const notifier = createMemoryStoreChangeNotifier();

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    // Stamp storeVersion=1 on first save (preserve existing if present)
    const versioned: BrickArtifact =
      brick.storeVersion !== undefined ? brick : { ...brick, storeVersion: 1 };
    bricks.set(versioned.id, versioned);
    notifier.notify({ kind: "saved", brickId: versioned.id });
    return { ok: true, value: undefined };
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const brick = bricks.get(id);
    if (brick === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    // Verify content integrity only for content-addressed IDs (sha256:<64-hex>).
    // Non-content-addressed IDs (legacy, test fixtures) bypass the check.
    if (isBrickId(brick.id)) {
      const check = verifyContentIntegrity(brick);
      if (!check.valid) {
        return { ok: false, error: integrityError(id, id, check.recomputedId) };
      }
    }
    return { ok: true, value: brick };
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    const filtered: BrickArtifact[] = [];
    for (const brick of bricks.values()) {
      if (matchesBrickQuery(brick, query)) {
        filtered.push(brick);
      }
    }
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });
    const limited = query.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
    return { ok: true, value: limited };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    if (!bricks.has(id)) {
      return { ok: false, error: notFoundError(id) };
    }
    bricks.delete(id);
    notifier.notify({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    // Optimistic locking: reject if version mismatch
    if (updates.expectedVersion !== undefined) {
      const currentVersion = existing.storeVersion ?? 0;
      if (currentVersion !== updates.expectedVersion) {
        return {
          ok: false,
          error: versionConflictError(id, updates.expectedVersion, currentVersion),
        };
      }
    }
    const applied = applyBrickUpdate(existing, updates);
    // Bump storeVersion on every successful update
    const nextVersion = (existing.storeVersion ?? 0) + 1;
    const versioned: BrickArtifact = { ...applied, storeVersion: nextVersion };
    bricks.set(id, versioned);
    notifier.notify({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
  };

  const searchSummaries = async (
    query: ForgeQuery,
  ): Promise<Result<readonly BrickSummary[], KoiError>> => {
    const result = await search(query);
    if (!result.ok) return result;
    const summaries: readonly BrickSummary[] = result.value.map(
      (brick: BrickArtifact): BrickSummary => ({
        id: brick.id,
        kind: brick.kind,
        name: brick.name,
        description: brick.description,
        tags: brick.tags,
        ...(brick.trigger !== undefined ? { trigger: brick.trigger } : {}),
      }),
    );
    return { ok: true, value: summaries };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: bricks.has(id) };
  };

  const promoteAndUpdate = async (
    id: BrickId,
    targetScope: ForgeScope,
    updates: BrickUpdate,
  ): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    // Optimistic locking for promote+update too
    if (updates.expectedVersion !== undefined) {
      const currentVersion = existing.storeVersion ?? 0;
      if (currentVersion !== updates.expectedVersion) {
        return {
          ok: false,
          error: versionConflictError(id, updates.expectedVersion, currentVersion),
        };
      }
    }
    const applied = applyBrickUpdate(existing, { ...updates, scope: targetScope });
    const nextVersion = (existing.storeVersion ?? 0) + 1;
    const versioned: BrickArtifact = { ...applied, storeVersion: nextVersion };
    bricks.set(id, versioned);
    notifier.notify({ kind: "promoted", brickId: id, scope: targetScope });
    return { ok: true, value: undefined };
  };

  return {
    save,
    load,
    search,
    searchSummaries,
    remove,
    update,
    exists,
    promoteAndUpdate,
    watch: notifier.subscribe,
  };
}
