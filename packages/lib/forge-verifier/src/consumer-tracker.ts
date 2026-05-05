/**
 * Live-consumer tracker for the cache-write gate. Extracted from
 * pipeline.ts in R37 to keep pipeline.ts under the 400-line soft
 * limit; semantics unchanged.
 *
 * Tracks how many callers (leader + followers) are still awaiting the
 * shared verification result. When every caller aborts before
 * completion, `liveConsumers` reaches 0 and the cache-write gate
 * suppresses persistence — caching a `passed: true` no live caller
 * accepted would let later callers receive a phantom pass.
 */

export interface ConsumerTracker {
  /** Read the current live-consumer count. */
  readonly liveConsumers: () => number;
  /** Add a follower; tracks their signal for abort-decrement. */
  readonly registerConsumer: (followerSignal: AbortSignal | undefined) => void;
  /** Remove every (signal, listener) pair installed so far. */
  readonly releaseConsumerListeners: () => void;
}

export function createConsumerTracker(leaderSignal: AbortSignal | undefined): ConsumerTracker {
  // Leader is the first live consumer. If their signal aborts before
  // `work()` resolves, decrement so the cache-write gate sees "gone".
  let liveConsumers = 1;
  const decrement = (): void => {
    if (liveConsumers > 0) liveConsumers -= 1;
  };
  // FRESH closure per registration — EventTarget dedupes (listener,
  // options) pairs by reference, so reusing `decrement` would fire
  // only once when leader + follower share an AbortSignal.
  const installed: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const install = (sig: AbortSignal): void => {
    const listener = (): void => decrement();
    sig.addEventListener("abort", listener, { once: true });
    installed.push({ signal: sig, listener });
  };
  if (leaderSignal !== undefined) {
    if (leaderSignal.aborted) decrement();
    else install(leaderSignal);
  }
  return {
    liveConsumers: () => liveConsumers,
    registerConsumer: (followerSignal) => {
      // Already aborted on arrival — never observes the result.
      if (followerSignal?.aborted === true) return;
      liveConsumers += 1;
      if (followerSignal !== undefined) install(followerSignal);
    },
    releaseConsumerListeners: () => {
      for (const { signal: s, listener } of installed) {
        s.removeEventListener("abort", listener);
      }
      installed.length = 0;
    },
  };
}
