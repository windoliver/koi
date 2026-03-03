/**
 * Failover execution — try primary, then alternatives sequentially.
 *
 * Circuit breakers are updated on each attempt. Open breakers are skipped
 * unless all are open (graceful degradation).
 */

import type { VariantAttempt } from "@koi/core";
import { type SelectVariantOptions, selectVariant } from "./select.js";
import type { BreakerMap, VariantEntry, VariantPool } from "./types.js";

/** Result of executing with failover. */
export interface FailoverResult<R> {
  readonly result: R;
  readonly attempts: readonly VariantAttempt[];
  readonly selectedVariantId: string;
}

/** Aggregate error when all variants fail. */
export interface AllFailedError {
  readonly ok: false;
  readonly attempts: readonly VariantAttempt[];
  readonly lastError: unknown;
}

export type FailoverOutcome<R> =
  | { readonly ok: true; readonly value: FailoverResult<R> }
  | AllFailedError;

export interface ExecuteWithFailoverOptions<T, R> {
  readonly pool: VariantPool<T>;
  readonly breakers: BreakerMap;
  readonly selectOptions: Omit<SelectVariantOptions<T>, "pool" | "breakers">;
  readonly execute: (variant: VariantEntry<T>) => Promise<R>;
  readonly clock: () => number;
}

export async function executeWithFailover<T, R>(
  options: ExecuteWithFailoverOptions<T, R>,
): Promise<FailoverOutcome<R>> {
  const { pool, breakers, selectOptions, execute, clock } = options;
  const failoverEnabled = pool.config.failoverEnabled;

  // Select primary variant
  const selection = selectVariant({
    ...selectOptions,
    pool,
    breakers,
  });

  if (!selection.ok) {
    return {
      ok: false,
      attempts: [],
      lastError: new Error(selection.reason),
    };
  }

  const attempts: VariantAttempt[] = [];

  // Try primary
  const primaryResult = await tryVariant(selection.selected, execute, breakers, clock);
  attempts.push(primaryResult.attempt);
  if (primaryResult.ok) {
    return {
      ok: true,
      value: {
        result: primaryResult.result,
        attempts,
        selectedVariantId: selection.selected.id,
      },
    };
  }

  // If failover is disabled, return immediately
  if (!failoverEnabled) {
    return { ok: false, attempts, lastError: primaryResult.error };
  }

  // Try alternatives sequentially
  let lastError: unknown = primaryResult.error;
  for (const alt of selection.alternatives) {
    // Skip open circuit breakers (but still try if all are open — handled by select)
    const breaker = breakers.get(alt.id);
    if (breaker !== undefined && !breaker.isAllowed()) continue;

    const altResult = await tryVariant(alt, execute, breakers, clock);
    attempts.push(altResult.attempt);
    if (altResult.ok) {
      return {
        ok: true,
        value: {
          result: altResult.result,
          attempts,
          selectedVariantId: alt.id,
        },
      };
    }
    lastError = altResult.error;
  }

  return { ok: false, attempts, lastError };
}

interface TryResult<R> {
  readonly ok: boolean;
  readonly result: R;
  readonly error: unknown;
  readonly attempt: VariantAttempt;
}

async function tryVariant<T, R>(
  variant: VariantEntry<T>,
  execute: (variant: VariantEntry<T>) => Promise<R>,
  breakers: BreakerMap,
  clock: () => number,
): Promise<TryResult<R>> {
  const start = clock();
  try {
    const result = await execute(variant);
    const durationMs = clock() - start;

    // Record success on circuit breaker
    const breaker = breakers.get(variant.id);
    breaker?.recordSuccess();

    return {
      ok: true,
      result,
      error: undefined,
      attempt: { variantId: variant.id, success: true, durationMs },
    };
  } catch (e: unknown) {
    const durationMs = clock() - start;

    // Record failure on circuit breaker
    const breaker = breakers.get(variant.id);
    breaker?.recordFailure();

    const errorMsg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      result: undefined as R,
      error: e,
      attempt: { variantId: variant.id, success: false, durationMs, error: errorMsg },
    };
  }
}
