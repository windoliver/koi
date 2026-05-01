/**
 * Lock-aware persistence helpers used by the verified-loop iteration body.
 *
 * Each helper wraps a PRD mutation (markDoneMany / bumpFailureCount) in:
 *   - a pre-write lock-ownership check (refuse to mutate if the lock has
 *     been stolen mid-iteration), and
 *   - a single CONFLICT retry against a freshly-read snapshot, distinguishing
 *     "item already done out-of-band" from "stale snapshot due to concurrent
 *     unrelated edit".
 *
 * Surfacing CONFLICT distinct from NOT_FOUND / VALIDATION / IO matters: a
 * genuinely successful iteration must not be replayed just because another
 * writer touched an unrelated row (that would re-execute non-idempotent side
 * effects).
 */

import {
  bumpFailureCount,
  markDoneMany,
  type PRDLock,
  readPRD,
  refreshPRDLock,
} from "./prd-store.js";

export async function persistCompletion(
  prdPath: string,
  lock: PRDLock,
  toComplete: readonly string[],
): Promise<void> {
  // Pre-write ownership check: refuse to mutate the PRD if
  // we have already lost the lock. Without this, a stolen
  // lock could still commit completion state for the rest of
  // the current iteration before the next iteration's check.
  const ownsBeforeDone = await refreshPRDLock(lock);
  if (!ownsBeforeDone) {
    throw new Error(
      `VerifiedLoop: refusing to commit completion for [${toComplete.join(", ")}] — PRD lock at ${lock.path} no longer owned by this coordinator`,
    );
  }
  // Use let — justified: retry counter for stale-snapshot CAS races.
  let doneAttempts = 0;
  while (true) {
    doneAttempts++;
    const doneResult = await markDoneMany(prdPath, toComplete);
    if (doneResult.ok) return;
    if (doneResult.error.code !== "CONFLICT") {
      throw new Error(
        `VerifiedLoop: failed to persist completion for [${toComplete.join(", ")}] (${doneResult.error.code}): ${doneResult.error.message}`,
      );
    }
    // CONFLICT — re-read and check whether all the items are now
    // already done (work was committed by another path). If so,
    // success. If still pending, retry once with fresh snapshot.
    const recheck = await readPRD(prdPath);
    if (!recheck.ok) {
      throw new Error(
        `VerifiedLoop: PRD became unreadable after CONFLICT for [${toComplete.join(", ")}] (${recheck.error.code}): ${recheck.error.message}`,
      );
    }
    const allAlreadyDone = toComplete.every(
      (id) => recheck.value.items.find((it) => it.id === id)?.done === true,
    );
    if (allAlreadyDone) {
      console.warn(
        `[verified-loop] Skipping completion persistence for [${toComplete.join(", ")}] (already done)`,
      );
      return;
    }
    if (doneAttempts >= 2) {
      throw new Error(
        `VerifiedLoop: failed to persist completion for [${toComplete.join(", ")}] after retry (concurrent writers contending on PRD): ${doneResult.error.message}`,
      );
    }
  }
}

export async function persistFailureBump(
  prdPath: string,
  lock: PRDLock,
  itemId: string,
  maxConsecutiveFailures: number,
): Promise<void> {
  // Pre-write ownership check (mirrors the markDoneMany path
  // above): a stolen lock must not be allowed to silently bump
  // the failure count of an item another coordinator owns.
  const ownsBeforeBump = await refreshPRDLock(lock);
  if (!ownsBeforeBump) {
    throw new Error(
      `VerifiedLoop: refusing to bump failure count for "${itemId}" — PRD lock at ${lock.path} no longer owned by this coordinator`,
    );
  }
  // Use let — justified: retry counter for stale-snapshot CAS races.
  let bumpAttempts = 0;
  while (true) {
    bumpAttempts++;
    const bumpResult = await bumpFailureCount(prdPath, itemId, maxConsecutiveFailures);
    if (bumpResult.ok) return;
    if (bumpResult.error.code !== "CONFLICT") {
      throw new Error(
        `VerifiedLoop: failed to persist failure count for "${itemId}" (${bumpResult.error.code}): ${bumpResult.error.message}`,
      );
    }
    // CONFLICT — distinguish "item became done out-of-band" from
    // "generic stale snapshot due to concurrent edit". Re-read.
    const recheck = await readPRD(prdPath);
    if (!recheck.ok) {
      throw new Error(
        `VerifiedLoop: PRD became unreadable after CONFLICT for "${itemId}" (${recheck.error.code}): ${recheck.error.message}`,
      );
    }
    const item = recheck.value.items.find((it) => it.id === itemId);
    if (item?.done === true) {
      console.warn(
        `[verified-loop] Skipping failure-count bump for "${itemId}" (already completed): ${bumpResult.error.message}`,
      );
      return;
    }
    // Generic stale-snapshot conflict (another writer touched
    // unrelated rows). Retry once with fresh state.
    if (bumpAttempts >= 2) {
      throw new Error(
        `VerifiedLoop: failed to persist failure count for "${itemId}" after retry (concurrent writers contending on PRD): ${bumpResult.error.message}`,
      );
    }
  }
}
