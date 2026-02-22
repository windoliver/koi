/**
 * Parallel disposal utility with per-item timeout.
 *
 * Uses Promise.allSettled() to ensure one failure doesn't block others.
 * Timeout prevents hung disposables from blocking shutdown.
 * Timers are cleared on settlement to prevent orphaned timers blocking exit.
 */

// ---------------------------------------------------------------------------
// Dispose all
// ---------------------------------------------------------------------------

/**
 * Dispose all AsyncDisposable services in parallel with a per-item timeout.
 *
 * @param disposables - Services to dispose
 * @param timeoutMs - Maximum time to wait for each disposal (default: 5000ms)
 */
export async function disposeAll(
  disposables: readonly AsyncDisposable[],
  timeoutMs = 5_000,
): Promise<void> {
  if (disposables.length === 0) return;

  const promises = disposables.map((d) => {
    let timerId: ReturnType<typeof setTimeout> | undefined; // let: captured by timeout, cleared on settlement

    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      timerId = setTimeout(() => reject(new Error("Disposal timed out")), timeoutMs);
    });

    // Wrap in Promise.resolve to get a full Promise (PromiseLike lacks .finally)
    return Promise.race([
      Promise.resolve(d[Symbol.asyncDispose]()).finally(() => {
        if (timerId !== undefined) clearTimeout(timerId);
      }),
      timeoutPromise,
    ]);
  });

  await Promise.allSettled(promises);
}
