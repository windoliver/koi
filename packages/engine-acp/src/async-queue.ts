/**
 * Push-to-pull bridge: converts push-based producers into an async iterable.
 *
 * Copied from @koi/engine-external with a high-watermark warning added
 * (decision 16A: unbounded queue + warn at 500 items).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueItem<T> {
  readonly value: T;
  readonly done: false;
}

interface QueueEnd {
  readonly done: true;
}

type QueueEntry<T> = QueueItem<T> | QueueEnd;

export interface AsyncQueue<T> extends AsyncIterable<T> {
  readonly push: (value: T) => void;
  readonly end: () => void;
}

const HIGH_WATERMARK = 500 as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAsyncQueue<T>(label?: string): AsyncQueue<T> {
  const buffer: QueueEntry<T>[] = [];
  // let: read pointer avoids O(n) Array.shift()
  let readIndex = 0;
  // let: pending consumer promise resolver
  let resolve: ((entry: QueueEntry<T>) => void) | undefined;
  // let: lifecycle flag
  let ended = false;

  function push(value: T): void {
    if (ended) return;
    const entry: QueueItem<T> = { value, done: false };
    if (resolve !== undefined) {
      const r = resolve;
      resolve = undefined;
      r(entry);
    } else {
      buffer.push(entry);
      const pending = buffer.length - readIndex;
      if (pending === HIGH_WATERMARK) {
        const tag = label !== undefined ? ` (${label})` : "";
        console.warn(
          `[engine-acp] AsyncQueue${tag}: ${pending} items pending — ` +
            "consumer may be too slow or the queue is unbounded.",
        );
      }
    }
  }

  function end(): void {
    if (ended) return;
    ended = true;
    const entry: QueueEnd = { done: true };
    if (resolve !== undefined) {
      const r = resolve;
      resolve = undefined;
      r(entry);
    } else {
      buffer.push(entry);
    }
  }

  async function next(): Promise<IteratorResult<T>> {
    if (readIndex < buffer.length) {
      const buffered = buffer[readIndex] as QueueEntry<T>;
      readIndex++;
      // Compact buffer periodically to release old references
      if (readIndex > 64) {
        buffer.splice(0, readIndex);
        readIndex = 0;
      }
      if (buffered.done) return { done: true, value: undefined };
      return { done: false, value: buffered.value };
    }

    const entry = await new Promise<QueueEntry<T>>((r) => {
      resolve = r;
    });

    if (entry.done) return { done: true, value: undefined };
    return { done: false, value: entry.value };
  }

  return {
    push,
    end,
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return { next };
    },
  };
}
