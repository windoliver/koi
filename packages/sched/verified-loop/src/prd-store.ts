/**
 * File-based PRD (Product Requirements Document) store.
 *
 * Reads, queries, and updates PRD items with atomic write-temp-rename.
 * Each mutator re-reads the file just before rename and surfaces CONFLICT
 * if the bytes changed since the snapshot it built from. This is a
 * BEST-EFFORT detector — there is still a TOCTOU window between the
 * pre-rename re-read and the rename itself, so concurrent writers CAN
 * still lose updates. The check catches the common case (a writer that
 * landed during the in-memory mutation step) but is not a substitute for
 * file locking.
 *
 * The package contract is single-coordinator. Multi-writer deployments
 * MUST add their own exclusion (file locking, distributed lease, single-
 * writer queue) at the deployment layer. The CAS check exists to surface
 * accidental dual coordinators loudly when it can, not to make multi-
 * writer access safe.
 */

import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { conflict, internal, notFound, validation } from "@koi/core";
import { extractMessage } from "@koi/errors";
import type { PRDFile, PRDItem } from "./types.js";

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
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return { ok: false, error: notFound(path, `PRD file not found: ${path}`) };
  }

  // Use let — justified: try/catch must reassign across boundaries
  let raw: string;
  try {
    raw = await file.text();
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

  return { ok: true, value: { prd: parsed as PRDFile, raw } };
}

/**
 * Atomic write with optimistic concurrency control: re-reads the file just
 * before rename and refuses if its bytes differ from `originalRaw`. Returns
 * CONFLICT on a lost-update race (another writer wrote in between), giving
 * the caller a chance to retry against the new state instead of silently
 * overwriting it.
 */
async function writePRDIfUnchanged(
  path: string,
  originalRaw: string,
  newPrd: PRDFile,
): Promise<Result<void, KoiError>> {
  // Write tmp first, then re-read-and-check just before rename. This
  // narrows the TOCTOU window between the CAS check and the rename to a
  // single syscall — anything more than that requires real exclusion
  // (file locking) which is the deployment-layer's responsibility per
  // this module's documented contract.
  // Random suffix so two concurrent writers don't collide on the same
  // `${path}.tmp` and produce ENOENT instead of a clean CONFLICT.
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  // Crash-durable write: open + write + fsync + close on the tmp file
  // BEFORE rename. Bun.write() returns once the data is in the page
  // cache, not when it's on disk — a host crash between markDoneMany()
  // returning success and the kernel flushing would silently lose
  // committed completion state. fsync the data, then rename, then
  // fsync the parent directory to make the rename itself durable.
  const tmpHandle = await open(tmpPath, "w");
  try {
    await tmpHandle.writeFile(JSON.stringify(newPrd, null, 2));
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      return {
        ok: false,
        error: conflict(path, `PRD file disappeared between read and write: ${path}`),
      };
    }
    const currentRaw = await file.text();
    if (currentRaw !== originalRaw) {
      return {
        ok: false,
        error: conflict(
          path,
          `PRD file changed between read and write (concurrent writer detected): ${path}`,
        ),
      };
    }
    await rename(tmpPath, path);
    // fsync the parent directory so the rename's directory-entry update
    // is also durable. Without this, a crash after rename can leave the
    // file pointing at the OLD inode on next mount even though the
    // new bytes are safely on disk. Best-effort: some filesystems
    // (network mounts, certain FUSE) don't support directory fsync.
    try {
      const dirHandle = await open(dirname(path), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (e: unknown) {
      // Only swallow "filesystem does not support directory fsync" errors
      // (FUSE, some network mounts, certain object-store gateways). Real
      // I/O failures (EIO, ENOSPC, EBADF) must propagate so the caller
      // does not falsely believe the write was crash-durable.
      const code = (e as { readonly code?: unknown }).code;
      const unsupported =
        code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS" || code === "EPERM";
      if (!unsupported) throw e;
    }
    return { ok: true, value: undefined };
  } catch (e: unknown) {
    // Best-effort tmp cleanup on any error path so we never leak tmps.
    await Bun.file(tmpPath)
      .delete()
      .catch(() => undefined);
    throw e;
  } finally {
    // If we returned a CONFLICT result above, the rename never ran and
    // the tmp is still on disk. Clean it up.
    if (await Bun.file(tmpPath).exists()) {
      await Bun.file(tmpPath)
        .delete()
        .catch(() => undefined);
    }
  }
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
  if (obj.priority !== undefined) {
    if (typeof obj.priority !== "number" || !Number.isFinite(obj.priority)) {
      return `'priority' must be a finite number if present`;
    }
  }
  if (obj.iterationCount !== undefined) {
    // Non-negative integer — counts can never be fractional or negative.
    // A hand-edited PRD with iterationCount: -5 would otherwise distort
    // every subsequent +1 and produce nonsensical history.
    if (
      typeof obj.iterationCount !== "number" ||
      !Number.isInteger(obj.iterationCount) ||
      obj.iterationCount < 0
    ) {
      return `'iterationCount' must be a non-negative integer if present`;
    }
  }
  if (obj.verifiedAt !== undefined && typeof obj.verifiedAt !== "string") {
    return `'verifiedAt' must be a string if present`;
  }
  if (obj.consecutiveFailureCount !== undefined) {
    // Same rationale as iterationCount: bumpFailureCount does
    // (count ?? 0) + 1 and compares to the skip threshold. Negative or
    // fractional persisted values would delay skipping or make the
    // budget behave unpredictably across restarts.
    if (
      typeof obj.consecutiveFailureCount !== "number" ||
      !Number.isInteger(obj.consecutiveFailureCount) ||
      obj.consecutiveFailureCount < 0
    ) {
      return `'consecutiveFailureCount' must be a non-negative integer if present`;
    }
  }
  // done and skipped are mutually exclusive in the result contract — the
  // same id must never appear in both completed[] and skipped[]. A PRD that
  // persists this combination (hand edit, partial-write recovery, third
  // party) must fail fast rather than silently feed the loop contradictory
  // state that downstream reports cannot disambiguate.
  if (obj.done === true && obj.skipped === true) {
    return `'done' and 'skipped' cannot both be true`;
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
  const newPrd: PRDFile = { items: newItems };

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
  const newPrd: PRDFile = { items: newItems };

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
  const newPrd: PRDFile = { items: newItems };

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
  const newPrd: PRDFile = { items: newItems };

  return writePRDIfUnchanged(path, raw, newPrd);
}
