/**
 * File-based PRD (Product Requirements Document) store.
 *
 * Single-coordinator access is enforced via an advisory `.lock` sidecar
 * file (acquirePRDLock / releasePRDLock — see `prd-lock.ts`). The
 * orchestrator acquires the lock for the entire run() invocation, so
 * concurrent verified-loop processes against the same PRD path are
 * refused at run-start instead of being allowed to race the optimistic
 * CAS below.
 *
 * Within the held lock, mutators still use atomic write-temp-rename and
 * a re-read CAS check before rename. The CAS guards against accidentally
 * unlocked or out-of-band edits (a human editing the file with the loop
 * paused, a cooperating tool that does not take the lock); under the
 * normal locked single-writer contract it is just defense-in-depth.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, internal, notFound, validation } from "@koi/core";
import { extractMessage } from "@koi/errors";
import { validatePRDItem } from "./prd-validate.js";
import { writePRDIfUnchanged } from "./prd-write.js";
import type { PRDFile, PRDItem } from "./types.js";

export {
  acquirePRDLock,
  type PRDLock,
  refreshPRDLock,
  releasePRDLock,
} from "./prd-lock.js";

/** Read and parse a PRD JSON file. */
export async function readPRD(path: string): Promise<Result<PRDFile, KoiError>> {
  const result = await readPRDWithSnapshot(path);
  if (!result.ok) return result;
  return { ok: true, value: result.value.prd };
}

/**
 * Internal variant of readPRD that also returns the raw bytes for
 * optimistic concurrency control. Mutators use this to capture a snapshot
 * to compare against just before rename.
 */
async function readPRDWithSnapshot(
  path: string,
): Promise<Result<{ readonly prd: PRDFile; readonly raw: string }, KoiError>> {
  const rawResult = await readPRDRaw(path);
  if (!rawResult.ok) return rawResult;
  const raw = rawResult.value;

  const parseResult = parsePRDJson(raw, path);
  if (!parseResult.ok) return parseResult;
  const parsed = parseResult.value;

  const itemsCheck = validatePRDItems(parsed, path);
  if (!itemsCheck.ok) return itemsCheck;

  return { ok: true, value: { prd: parsed, raw } };
}

async function readPRDRaw(path: string): Promise<Result<string, KoiError>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return { ok: false, error: notFound(path, `PRD file not found: ${path}`) };
  }
  try {
    const raw = await file.text();
    return { ok: true, value: raw };
  } catch (e: unknown) {
    // The exists() check above already passed, so a failure here is a
    // real I/O fault (permission denied, transient EIO, path-type
    // mismatch, race-deletion) — not a missing file. Surfacing it as
    // NOT_FOUND would mask storage-health problems and break recovery
    // logic that distinguishes "no PRD yet" from "storage is sick".
    // ENOENT can still race in between exists() and text(); classify
    // that narrow case as NOT_FOUND to preserve the original semantics.
    const code = (e as { readonly code?: unknown }).code;
    if (code === "ENOENT") {
      return { ok: false, error: notFound(path, `PRD file not found: ${path}`) };
    }
    return {
      ok: false,
      error: internal(`Failed to read PRD file at ${path}: ${extractMessage(e)}`, e),
    };
  }
}

function parsePRDJson(raw: string, path: string): Result<PRDFile, KoiError> {
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

  return { ok: true, value: parsed as PRDFile };
}

function validatePRDItems(parsed: PRDFile, path: string): Result<void, KoiError> {
  const rawItems = parsed.items as readonly unknown[];
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
  return { ok: true, value: undefined };
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
  const readResult = await readPRDWithSnapshot(path);
  if (!readResult.ok) return readResult;

  const { prd, raw } = readResult.value;
  const { items } = prd;
  const index = items.findIndex((item) => item.id === itemId);
  const target = index === -1 ? undefined : items[index];
  if (target === undefined) {
    return { ok: false, error: notFound(itemId, `PRD item not found: ${itemId}`) };
  }

  // Refuse to bump failure count on an item that is already done. An
  // out-of-band edit (or a concurrent run) could complete the item between
  // the loop selecting it and the failed gate persisting the failure; without
  // this guard, that race produces a contradictory done:true + skipped:true
  // record. markSkipped enforces the same invariant — bumpFailureCount must
  // not be a back door around it.
  if (target.done) {
    // CONFLICT (not VALIDATION): the input was structurally fine — the item
    // simply transitioned to done out-of-band between selection and the
    // failure persistence call. The orchestrator handles this distinct
    // outcome by skipping the bump rather than treating it as fatal, while
    // unrelated VALIDATION (e.g. corrupt PRD) still throws.
    return {
      ok: false,
      error: conflict(itemId, `Cannot bump failure count on completed item: ${itemId}`),
    };
  }

  const newCount = (target.consecutiveFailureCount ?? 0) + 1;
  const shouldSkip = newCount >= maxConsecutiveFailures;
  const updated: PRDItem = {
    ...target,
    consecutiveFailureCount: newCount,
    ...(shouldSkip ? { skipped: true } : {}),
  };
  const newItems = items.map((item, i) => (i === index ? updated : item));
  // Spread `prd` to preserve unknown top-level fields (operator-added
  // metadata, future schema versions like `version`, scheduling hints).
  // Reconstructing as `{ items: newItems }` would silently delete them
  // on the first successful write — irreversible data loss.
  const newPrd: PRDFile = { ...prd, items: newItems };

  const writeResult = await writePRDIfUnchanged(path, raw, newPrd);
  if (!writeResult.ok) return writeResult;

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

/**
 * Mark a PRD item as skipped with atomic write-temp-rename. Refuses to skip
 * an already-completed item: `done` and `skipped` are mutually exclusive
 * states in the result contract (the same id must never appear in both
 * arrays). Callers see VALIDATION on misuse rather than a contradictory PRD.
 */
export async function markSkipped(path: string, itemId: string): Promise<Result<void, KoiError>> {
  const readResult = await readPRDWithSnapshot(path);
  if (!readResult.ok) return readResult;

  const { prd, raw } = readResult.value;
  const { items } = prd;
  const index = items.findIndex((item) => item.id === itemId);
  const target = index === -1 ? undefined : items[index];
  if (target === undefined) {
    return { ok: false, error: notFound(itemId, `PRD item not found: ${itemId}`) };
  }
  if (target.done) {
    return { ok: false, error: conflict(itemId, `Cannot skip completed item: ${itemId}`) };
  }

  const updated: PRDItem = { ...target, skipped: true };
  const newItems = items.map((item, i) => (i === index ? updated : item));
  // Spread `prd` to preserve unknown top-level fields (operator-added
  // metadata, future schema versions like `version`, scheduling hints).
  // Reconstructing as `{ items: newItems }` would silently delete them
  // on the first successful write — irreversible data loss.
  const newPrd: PRDFile = { ...prd, items: newItems };

  return writePRDIfUnchanged(path, raw, newPrd);
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

  const readResult = await readPRDWithSnapshot(path);
  if (!readResult.ok) return readResult;

  const { prd, raw } = readResult.value;
  const { items } = prd;
  const idSet = new Set(itemIds);
  // Pre-flight: every requested id must exist before we touch the file.
  for (const id of idSet) {
    if (!items.some((item) => item.id === id)) {
      return { ok: false, error: notFound(id, `PRD item not found: ${id}`) };
    }
  }

  const now = new Date().toISOString();
  // Preserve history for already-completed items: a gate that re-reports the
  // same id across iterations (cumulative itemsCompleted) or a retry of the
  // same set must NOT overwrite verifiedAt or re-increment iterationCount,
  // since that would silently rewrite earlier verification timestamps.
  const newItems = items.map((item) => {
    if (!idSet.has(item.id)) return item;
    if (item.done) return item;
    return {
      ...item,
      done: true,
      verifiedAt: now,
      iterationCount: (item.iterationCount ?? 0) + 1,
      skipped: false,
      consecutiveFailureCount: 0,
    };
  });
  // Spread `prd` to preserve unknown top-level fields (operator-added
  // metadata, future schema versions like `version`, scheduling hints).
  // Reconstructing as `{ items: newItems }` would silently delete them
  // on the first successful write — irreversible data loss.
  const newPrd: PRDFile = { ...prd, items: newItems };

  return writePRDIfUnchanged(path, raw, newPrd);
}

async function updateItem(
  path: string,
  itemId: string,
  mutate: (item: PRDItem) => PRDItem,
): Promise<Result<void, KoiError>> {
  const readResult = await readPRDWithSnapshot(path);
  if (!readResult.ok) return readResult;

  const { prd, raw } = readResult.value;
  const { items } = prd;
  const index = items.findIndex((item) => item.id === itemId);
  const target = index === -1 ? undefined : items[index];
  if (target === undefined) {
    return { ok: false, error: notFound(itemId, `PRD item not found: ${itemId}`) };
  }

  const updated = mutate(target);
  const newItems = items.map((item, i) => (i === index ? updated : item));
  // Spread `prd` to preserve unknown top-level fields (operator-added
  // metadata, future schema versions like `version`, scheduling hints).
  // Reconstructing as `{ items: newItems }` would silently delete them
  // on the first successful write — irreversible data loss.
  const newPrd: PRDFile = { ...prd, items: newItems };

  return writePRDIfUnchanged(path, raw, newPrd);
}
