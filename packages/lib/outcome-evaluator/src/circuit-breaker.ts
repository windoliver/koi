/**
 * Circuit breaker for the rubric iteration loop.
 *
 * Trips when the same set of failing required-criterion names appears
 * consecutively N times. The counter resets on ANY change to the failing set
 * (including partial improvement), preventing false termination on real progress.
 */

export interface CircuitBreaker {
  /**
   * Record a set of failing criterion names for this iteration.
   * Returns true if the circuit tripped on this call (i.e., consecutive count
   * reached or exceeded maxConsecutive). Counter resets when failing set changes.
   */
  readonly record: (failingNames: ReadonlySet<string>) => boolean;
  /** Reset all internal state (call after a satisfied result). */
  readonly reset: () => void;
  /** Current consecutive count — useful for debugging/tests. */
  readonly consecutiveCount: () => number;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export function createCircuitBreaker(maxConsecutive: number): CircuitBreaker {
  // let justified: mutable state tracking consecutive identical failures
  let lastFailingSet: ReadonlySet<string> | undefined;
  let count = 0;

  return {
    record(failingNames: ReadonlySet<string>): boolean {
      if (failingNames.size === 0) {
        // All criteria passed — reset
        lastFailingSet = undefined;
        count = 0;
        return false;
      }

      if (lastFailingSet !== undefined && setsEqual(failingNames, lastFailingSet)) {
        count++;
      } else {
        // Failing set changed (improvement or regression) — reset counter
        lastFailingSet = failingNames;
        count = 1;
      }

      return count >= maxConsecutive;
    },

    reset(): void {
      lastFailingSet = undefined;
      count = 0;
    },

    consecutiveCount(): number {
      return count;
    },
  };
}
