/**
 * File-based PRD (Product Requirements Document) store.
 *
 * Reads, queries, and updates PRD items with atomic write-temp-rename.
 *
 * IMPORTANT: This module assumes a single event loop per PRD file.
 * The read-modify-write pattern in markDone/markSkipped is NOT safe
 * for concurrent multi-process access — concurrent writes will
 * silently overwrite each other. If multi-process access is needed,
 * add external file locking or serialise through a single coordinator.
 */

import { rename } from "node:fs/promises";
import type { KoiError, Result } from "@koi/core";
import { notFound, validation } from "@koi/core";
import type { PRDFile, PRDItem } from "./types.js";

/** Read and parse a PRD JSON file. */
export async function readPRD(path: string): Promise<Result<PRDFile, KoiError>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return { ok: false, error: notFound(path, `PRD file not found: ${path}`) };
  }

  // Use let — justified: try/catch must reassign across boundaries
  let raw: string;
  try {
    raw = await file.text();
  } catch (_e: unknown) {
    return { ok: false, error: notFound(path, `Failed to read PRD file: ${path}`) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_e: unknown) {
    return {
      ok: false,
      error: validation(`PRD file contains invalid JSON: ${path}`),
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("items" in parsed) ||
    !Array.isArray((parsed as { readonly items?: unknown }).items)
  ) {
    return {
      ok: false,
      error: validation(`PRD file missing required 'items' array: ${path}`),
    };
  }

  const rawItems = (parsed as { readonly items: readonly unknown[] }).items;
  const seenIds = new Set<string>();
  for (let idx = 0; idx < rawItems.length; idx++) {
    const issue = validatePRDItem(rawItems[idx]);
    if (issue !== undefined) {
      return {
        ok: false,
        error: validation(`PRD file has invalid item at index ${idx}: ${issue} (${path})`),
      };
    }
    const id = (rawItems[idx] as { readonly id: string }).id;
    if (seenIds.has(id)) {
      // Duplicate ids are toxic: updateItem() mutates the first match only,
      // so the second copy could stay undone forever while markDone keeps
      // rewriting the wrong row.
      return {
        ok: false,
        error: validation(`PRD file has duplicate item id "${id}" at index ${idx} (${path})`),
      };
    }
    seenIds.add(id);
  }

  return { ok: true, value: parsed as PRDFile };
}

/**
 * Validate one PRD item structurally. Returns undefined if valid, or a
 * human-readable issue description otherwise. Hand-edited PRDs frequently
 * contain bugs like `done: "false"` (truthy string) which silently break
 * `nextItem` — fail fast instead.
 */
function validatePRDItem(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) {
    return `not an object`;
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return `'id' must be a non-empty string`;
  }
  if (typeof obj.description !== "string") {
    return `'description' must be a string`;
  }
  if (typeof obj.done !== "boolean") {
    return `'done' must be a boolean (got ${typeof obj.done})`;
  }
  if (obj.skipped !== undefined && typeof obj.skipped !== "boolean") {
    return `'skipped' must be a boolean if present`;
  }
  if (obj.priority !== undefined && typeof obj.priority !== "number") {
    return `'priority' must be a number if present`;
  }
  if (obj.iterationCount !== undefined && typeof obj.iterationCount !== "number") {
    return `'iterationCount' must be a number if present`;
  }
  if (obj.verifiedAt !== undefined && typeof obj.verifiedAt !== "string") {
    return `'verifiedAt' must be a string if present`;
  }
  if (
    obj.consecutiveFailureCount !== undefined &&
    typeof obj.consecutiveFailureCount !== "number"
  ) {
    return `'consecutiveFailureCount' must be a number if present`;
  }
  return undefined;
}

/**
 * Atomically increment the per-item consecutive-failure count and, if it
 * reaches `maxConsecutiveFailures`, mark the item as skipped in the same
 * write. Persisted to disk so crash/restart preserves the failure budget.
 *
 * Returns the new count (or 0 with `skipped: true` if the threshold was met).
 */
export async function bumpFailureCount(
  path: string,
  itemId: string,
  maxConsecutiveFailures: number,
): Promise<Result<{ readonly count: number; readonly skipped: boolean }, KoiError>> {
  const readResult = await readPRD(path);
  if (!readResult.ok) return readResult;

  const { items } = readResult.value;
  const index = items.findIndex((item) => item.id === itemId);
  const target = index === -1 ? undefined : items[index];
  if (target === undefined) {
    return { ok: false, error: notFound(itemId, `PRD item not found: ${itemId}`) };
  }

  const newCount = (target.consecutiveFailureCount ?? 0) + 1;
  const shouldSkip = newCount >= maxConsecutiveFailures;
  const updated: PRDItem = {
    ...target,
    consecutiveFailureCount: newCount,
    ...(shouldSkip ? { skipped: true } : {}),
  };
  const newItems = items.map((item, i) => (i === index ? updated : item));
  const newPrd: PRDFile = { items: newItems };

  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(newPrd, null, 2));
  await rename(tmpPath, path);

  return { ok: true, value: { count: newCount, skipped: shouldSkip } };
}

/** Reset the consecutive-failure count for an item (e.g. on success). */
export async function resetFailureCount(
  path: string,
  itemId: string,
): Promise<Result<void, KoiError>> {
  return updateItem(path, itemId, (target) =>
    target.consecutiveFailureCount === undefined
      ? target
      : { ...target, consecutiveFailureCount: 0 },
  );
}

/** Return the highest-priority undone/unskipped PRD item, or undefined if none remain. */
export function nextItem(items: readonly PRDItem[]): PRDItem | undefined {
  const candidates = items.filter((item) => !item.done && !item.skipped);
  if (candidates.length === 0) return undefined;
  // Sort by priority (lower = higher priority); preserve doc order on ties (stable sort).
  const sorted = [...candidates].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return sorted[0];
}

/** Mark a PRD item as skipped with atomic write-temp-rename. */
export async function markSkipped(path: string, itemId: string): Promise<Result<void, KoiError>> {
  return updateItem(path, itemId, (target) => ({ ...target, skipped: true }));
}

/**
 * Mark a PRD item as done with atomic write-temp-rename. Also normalizes
 * any prior failure metadata: clears `skipped` (an item completed indirectly
 * via `itemsCompleted` should not remain in the skipped result set) and
 * resets `consecutiveFailureCount` (success cancels prior streak).
 */
export async function markDone(path: string, itemId: string): Promise<Result<void, KoiError>> {
  return markDoneMany(path, [itemId]);
}

/**
 * Mark several PRD items as done in a single atomic write. Used when one
 * verification iteration completes multiple items: a per-id loop of markDone
 * calls would persist them as separate atomic operations, leaving room for
 * a crash to commit only a prefix of the set. One temp-rename = whole-set
 * atomicity.
 *
 * Returns NOT_FOUND if any id is missing, with no write performed.
 */
export async function markDoneMany(
  path: string,
  itemIds: readonly string[],
): Promise<Result<void, KoiError>> {
  if (itemIds.length === 0) {
    return { ok: true, value: undefined };
  }

  const readResult = await readPRD(path);
  if (!readResult.ok) return readResult;

  const { items } = readResult.value;
  const idSet = new Set(itemIds);
  // Pre-flight: every requested id must exist before we touch the file.
  for (const id of idSet) {
    if (!items.some((item) => item.id === id)) {
      return { ok: false, error: notFound(id, `PRD item not found: ${id}`) };
    }
  }

  const now = new Date().toISOString();
  const newItems = items.map((item) =>
    idSet.has(item.id)
      ? {
          ...item,
          done: true,
          verifiedAt: now,
          iterationCount: (item.iterationCount ?? 0) + 1,
          skipped: false,
          consecutiveFailureCount: 0,
        }
      : item,
  );
  const newPrd: PRDFile = { items: newItems };

  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(newPrd, null, 2));
  await rename(tmpPath, path);

  return { ok: true, value: undefined };
}

async function updateItem(
  path: string,
  itemId: string,
  mutate: (item: PRDItem) => PRDItem,
): Promise<Result<void, KoiError>> {
  const readResult = await readPRD(path);
  if (!readResult.ok) {
    return readResult;
  }

  const { items } = readResult.value;
  const index = items.findIndex((item) => item.id === itemId);
  const target = index === -1 ? undefined : items[index];
  if (target === undefined) {
    return { ok: false, error: notFound(itemId, `PRD item not found: ${itemId}`) };
  }

  const updated = mutate(target);
  const newItems = items.map((item, i) => (i === index ? updated : item));
  const newPrd: PRDFile = { items: newItems };

  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(newPrd, null, 2));
  await rename(tmpPath, path);

  return { ok: true, value: undefined };
}
