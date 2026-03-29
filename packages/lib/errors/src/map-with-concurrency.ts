/**
 * Bounded-concurrency map — processes items in parallel with at most
 * `concurrency` concurrent executions, preserving input order.
 *
 * Unlike batch-based approaches that wait for an entire batch before
 * starting the next, this uses a sliding-window strategy: a new item
 * starts as soon as any slot frees up, maximizing throughput.
 */

/**
 * Maps over `items` with at most `concurrency` concurrent calls to `fn`.
 * Results preserve input order (result[i] corresponds to items[i]).
 * Rejects on the first error, like `Promise.all`.
 *
 * @param items - Input array to map over
 * @param fn - Async mapper receiving item and its index
 * @param concurrency - Maximum number of concurrent executions (must be > 0)
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<readonly R[]> {
  if (concurrency <= 0) {
    throw new Error(`concurrency must be > 0, got ${String(concurrency)}`);
  }

  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      // eslint-disable-next-line no-await-in-loop -- intentional sequential within worker
      results[i] = await fn(items[i] as T, i);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers: readonly Promise<void>[] = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}
