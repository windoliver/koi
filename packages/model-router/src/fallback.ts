/**
 * Fallback chain orchestration.
 *
 * Tries targets in order, skipping those with open circuit breakers.
 * If all targets fail, returns an aggregated error.
 * If all circuit breakers are open, bypasses them (graceful degradation).
 */

import type { KoiError, Result } from "@koi/core";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { toKoiError } from "./error-utils.js";

export interface FallbackTarget {
  readonly id: string;
  readonly enabled: boolean;
}

export interface FallbackAttempt {
  readonly targetId: string;
  readonly success: boolean;
  readonly error?: KoiError;
  readonly durationMs: number;
}

export interface FallbackResult<T> {
  readonly value: T;
  readonly targetIndex: number;
  readonly attempts: readonly FallbackAttempt[];
}

/**
 * Executes `fn` against targets in order with circuit breaker awareness.
 *
 * Strategy:
 * 1. Filter enabled targets
 * 2. Skip targets with open circuit breakers
 * 3. If all targets are circuit-broken, bypass breakers (prefer degraded over none)
 * 4. Execute fn against each remaining target until one succeeds
 * 5. Record success/failure in circuit breakers
 *
 * @param targets - Ordered list of fallback targets
 * @param fn - Function to execute against a target
 * @param circuitBreakers - Map of target ID → CircuitBreaker
 * @param clock - Injectable clock for timing
 */
export async function withFallback<T>(
  targets: readonly FallbackTarget[],
  fn: (target: FallbackTarget) => Promise<T>,
  circuitBreakers: ReadonlyMap<string, CircuitBreaker>,
  clock: () => number = Date.now,
): Promise<Result<FallbackResult<T>, KoiError>> {
  const enabledTargets = targets.filter((t) => t.enabled);

  if (enabledTargets.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "No enabled targets in fallback chain",
        retryable: false,
      },
    };
  }

  // Determine which targets are allowed by circuit breakers
  let candidateTargets = enabledTargets.filter((t) => {
    const cb = circuitBreakers.get(t.id);
    return cb === undefined || cb.isAllowed();
  });

  // Graceful degradation: if all targets are circuit-broken, try them anyway
  if (candidateTargets.length === 0) {
    candidateTargets = enabledTargets;
  }

  const attempts: FallbackAttempt[] = [];

  for (let i = 0; i < candidateTargets.length; i++) {
    const target = candidateTargets[i];
    if (target === undefined) continue;
    const startMs = clock();

    try {
      const value = await fn(target);
      const durationMs = clock() - startMs;

      // Record success in circuit breaker
      const cb = circuitBreakers.get(target.id);
      cb?.recordSuccess();

      attempts.push({ targetId: target.id, success: true, durationMs });

      return {
        ok: true,
        value: {
          value,
          targetIndex: i,
          attempts: [...attempts],
        },
      };
    } catch (error: unknown) {
      const durationMs = clock() - startMs;
      const koiError = toKoiError(error);

      // Record failure in circuit breaker
      const cb = circuitBreakers.get(target.id);
      cb?.recordFailure();

      attempts.push({ targetId: target.id, success: false, error: koiError, durationMs });
    }
  }

  // All targets failed — aggregate errors
  return {
    ok: false,
    error: {
      code: "EXTERNAL",
      message: `All ${attempts.length} targets failed: ${attempts.map((a) => `${a.targetId}: ${a.error?.message ?? "unknown"}`).join("; ")}`,
      retryable: false,
      context: {
        attempts: attempts.map((a) => ({
          targetId: a.targetId,
          error: a.error?.message,
          durationMs: a.durationMs,
        })),
      },
    },
  };
}
