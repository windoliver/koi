/**
 * Bounded async iterable message queue for streaming input to the Claude SDK.
 *
 * Pattern from Anthropic's claude-agent-sdk-demos: single-pending-Promise
 * blocking with bounded buffer and drop-oldest overflow policy.
 */

const DEFAULT_MAX_SIZE = 100;

export interface MessageQueueOptions {
  readonly maxSize?: number;
}

export interface MessageQueue<T> extends AsyncIterable<T> {
  /** Push an item into the queue. No-op after close(). */
  readonly push: (item: T) => void;
  /** Close the queue — signals iteration to end. */
  readonly close: () => void;
  /** Current number of buffered items. */
  readonly size: number;
  /** Whether the queue has been closed. */
  readonly closed: boolean;
}

/**
 * Create a bounded async iterable queue.
 *
 * - When a consumer is waiting (via `for await`), `push()` resolves immediately.
 * - When no consumer is waiting, items buffer up to `maxSize`.
 * - On overflow: drops oldest message and emits a warning.
 * - `close()` signals the async iterator to stop.
 * - `push()` after `close()` is a no-op with a warning.
 */
export function createMessageQueue<T>(options?: MessageQueueOptions): MessageQueue<T> {
  const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  const buffer: T[] = [];
  // let: single pending consumer resolver — set when iterator awaits, cleared on resolve
  let pendingResolve: ((wrapped: { readonly value: T } | undefined) => void) | undefined;
  // let: toggled by close()
  let isClosed = false;

  const queue: MessageQueue<T> = {
    push(item: T): void {
      if (isClosed) {
        console.warn("MessageQueue: push() called after close() — message dropped");
        return;
      }

      if (pendingResolve !== undefined) {
        // Consumer is waiting — resolve immediately, no buffering
        const resolve = pendingResolve;
        pendingResolve = undefined;
        resolve({ value: item });
        return;
      }

      // Buffer the item
      if (buffer.length >= maxSize) {
        buffer.shift();
        console.warn(`MessageQueue: buffer full (max ${maxSize}) — dropping oldest message`);
      }
      buffer.push(item);
    },

    close(): void {
      if (isClosed) return;
      isClosed = true;

      if (pendingResolve !== undefined) {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        resolve(undefined);
      }
    },

    get size(): number {
      return buffer.length;
    },

    get closed(): boolean {
      return isClosed;
    },

    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
      while (true) {
        // Drain buffer first
        if (buffer.length > 0) {
          // biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees element exists
          yield buffer.shift()!;
          continue;
        }

        // Buffer empty + closed → done
        if (isClosed) return;

        // Wait for next push() or close()
        const result = await new Promise<{ readonly value: T } | undefined>((resolve) => {
          pendingResolve = resolve;
        });

        // close() was called while waiting
        if (result === undefined) return;

        yield result.value;
      }
    },
  };

  return queue;
}
