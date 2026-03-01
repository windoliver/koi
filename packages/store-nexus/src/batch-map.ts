/**
 * Bounded-concurrency batch map utility.
 *
 * Processes items in batches of `concurrency` size, awaiting each batch
 * before starting the next. Prevents unbounded parallel I/O against
 * the Nexus server.
 */

export async function batchMap<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<readonly R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
