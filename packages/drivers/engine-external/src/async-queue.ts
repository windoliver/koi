/**
 * Push-to-pull bridge: converts push-based producers into an async iterable.
 *
 * Function-based implementation — closures over internal state.
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAsyncQueue<T>(): AsyncQueue<T> {
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
