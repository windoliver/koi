/**
 * LifecyclePolicy validation + freeze-at-save helper.
 *
 * `validateLifecyclePolicy` is invoked from `createArtifactStore` at
 * construction time; misconfigured policies are a programmer error so it
 * throws rather than returning a Result.
 *
 * `computeExpiresAt` produces the value stamped on `artifacts.expires_at` at
 * save time and frozen on the row — subsequent policy changes never
 * recompute or resurrect an already-frozen value (see §4 / §6.1 of
 * docs/superpowers/specs/2026-04-18-artifacts-design.md).
 */

import type { LifecyclePolicy } from "./types.js";

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `LifecyclePolicy.${field} must be a finite integer >= 1; got ${String(value)}. Zero, negative, fractional, NaN, and Infinity are rejected to surface misconfiguration at store construction rather than at save time.`,
    );
  }
}

export function validateLifecyclePolicy(policy: LifecyclePolicy | undefined): void {
  if (policy === undefined) return;
  if (policy.ttlMs !== undefined) assertPositiveInt(policy.ttlMs, "ttlMs");
  if (policy.maxSessionBytes !== undefined)
    assertPositiveInt(policy.maxSessionBytes, "maxSessionBytes");
  if (policy.maxVersionsPerName !== undefined)
    assertPositiveInt(policy.maxVersionsPerName, "maxVersionsPerName");
}

export function computeExpiresAt(createdAt: number, policy?: LifecyclePolicy): number | null {
  if (policy?.ttlMs === undefined) return null;
  return createdAt + policy.ttlMs;
}
