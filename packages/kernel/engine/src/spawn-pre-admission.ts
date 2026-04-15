/**
 * Pre-admission marker for spawn errors.
 *
 * The spawn guard (@koi/engine-compose createSpawnGuard) uses this marker
 * to decide whether a failed spawn should refund its per-turn fan-out
 * budget. A child that was never actually admitted (arg parsing,
 * resolver NOT_FOUND, permission subset check, delivery validation,
 * slot acquisition, governance denial, assembly failure) should not
 * consume the parent's burst quota. Child-run failures after admission
 * must keep consuming the quota — otherwise a parent could spam
 * fast-failing children and bypass the cap (#1793).
 *
 * Contract: pre-admission errors carry `context.preAdmission === true`.
 * The guard catches KoiRuntimeError instances and reads this flag.
 * Everything else (plain Error, tagged post-admission errors) is
 * treated as post-admission and stays counted.
 */

import type { KoiError } from "@koi/core";

/** Attach `context.preAdmission = true` to a KoiError without mutating it. */
export function markPreAdmission(error: KoiError): KoiError {
  return {
    ...error,
    context: { ...(error.context ?? {}), preAdmission: true },
  };
}
