/**
 * Promise concurrency pool — runs tasks with a bounded number in-flight.
 */

export async function runPool<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
  onComplete?: (result: T) => void,
): Promise<readonly T[]> {
  const results: T[] = new Array(tasks.length) as T[];
  // let justified: mutable index for next task to dispatch
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (task === undefined) continue;
      const result = await task();
      results[index] = result;
      onComplete?.(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
  await Promise.all(workers);

  return results;
}
