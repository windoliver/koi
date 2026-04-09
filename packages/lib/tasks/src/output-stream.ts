/**
 * In-memory output stream for task incremental output.
 *
 * Stores output chunks with byte offsets for delta-based reads.
 * Memory-capped with oldest-chunk eviction.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single chunk of task output with its byte offset. */
export interface OutputChunk {
  readonly offset: number;
  readonly content: string;
  /** UTF-8 byte length of content. */
  readonly byteLength: number;
  readonly timestamp: number;
}

/** Readable/writable stream for task output with subscription support. */
export interface TaskOutputStream {
  /** Total bytes written (including evicted chunks). */
  readonly length: () => number;
  /** Read all chunks from `fromOffset` onward. Returns from earliest available if offset was evicted. */
  readonly read: (fromOffset: number) => readonly OutputChunk[];
  /** Append content. Returns new total length. */
  readonly write: (content: string) => number;
  /** Subscribe to new chunks. Returns unsubscribe function. */
  readonly subscribe: (listener: (chunk: OutputChunk) => void) => () => void;
  readonly [Symbol.dispose]: () => void;
}

/** Configuration for output stream. */
export interface OutputStreamConfig {
  /** Maximum buffered bytes before oldest chunks are evicted. Default: 8MB. */
  readonly maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory TaskOutputStream.
 *
 * Chunks are stored with monotonic byte offsets. When buffered bytes exceed
 * `maxBytes`, the oldest chunks are evicted (but `length()` still reports
 * total bytes ever written).
 */
export function createOutputStream(config?: OutputStreamConfig): TaskOutputStream {
  const maxBytes = Math.max(config?.maxBytes ?? DEFAULT_MAX_BYTES, 1);

  // Deque-style buffer: chunks[headIndex .. chunks.length - 1] is the live
  // window. Eviction increments headIndex (O(1)) instead of array-shifting.
  // Periodic compaction via splice keeps the array from growing unboundedly
  // under a write-heavy workload. Before the head-pointer refactor, every
  // evict() call was O(N) and eviction-heavy workloads were O(N²).
  const chunks: OutputChunk[] = [];
  // let justified: mutable head pointer for deque-style eviction
  let headIndex = 0;
  let totalBytes = 0;
  let bufferedBytes = 0;
  const listeners = new Set<(chunk: OutputChunk) => void>();

  /** Compact the buffer when enough dead entries accumulate. */
  const compactIfNeeded = (): void => {
    // Only compact when headIndex is both absolutely large (>64) AND relatively
    // large (majority of the array is dead). Avoids thrashing for small buffers.
    if (headIndex > 64 && headIndex > chunks.length / 2) {
      chunks.splice(0, headIndex);
      headIndex = 0;
    }
  };

  const evict = (): void => {
    // Keep at least one chunk live so read() always has something to return
    // when the caller's offset straddles the tail.
    while (bufferedBytes > maxBytes && chunks.length - headIndex > 1) {
      const evicted = chunks[headIndex];
      if (evicted === undefined) break;
      headIndex += 1;
      bufferedBytes -= evicted.byteLength;
    }
    compactIfNeeded();
  };

  /**
   * Binary search for the first chunk whose offset >= targetOffset.
   * Chunks are sorted by offset (monotonically increasing).
   *
   * The search window starts at headIndex so evicted entries are ignored.
   */
  const findStartIndex = (targetOffset: number): number => {
    let lo = headIndex;
    let hi = chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midChunk = chunks[mid];
      if (midChunk !== undefined && midChunk.offset + midChunk.byteLength <= targetOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const read = (fromOffset: number): readonly OutputChunk[] => {
    if (chunks.length - headIndex === 0) return [];
    const idx = findStartIndex(fromOffset);
    if (idx >= chunks.length) return [];

    const result = chunks.slice(idx);

    // If the requested offset falls mid-chunk, trim the first chunk
    // to only include content after the offset. Advance to the next
    // valid UTF-8 character boundary to prevent corrupted output.
    const first = result[0];
    if (first !== undefined && first.offset < fromOffset) {
      const encoded = encoder.encode(first.content);
      // let justified: advance past the skip point to a valid UTF-8 boundary
      let skipBytes = fromOffset - first.offset;
      // UTF-8 continuation bytes start with 0b10xxxxxx (0x80-0xBF).
      // Advance past any continuation bytes to the next character start.
      while (skipBytes < encoded.byteLength && ((encoded[skipBytes] ?? 0) & 0xc0) === 0x80) {
        skipBytes += 1;
      }
      if (skipBytes < encoded.byteLength) {
        const trimmedBytes = encoded.slice(skipBytes);
        const trimmedContent = new TextDecoder().decode(trimmedBytes);
        const adjustedOffset = first.offset + skipBytes;
        const trimmed: OutputChunk = {
          offset: adjustedOffset,
          content: trimmedContent,
          byteLength: trimmedBytes.byteLength,
          timestamp: first.timestamp,
        };
        return [trimmed, ...result.slice(1)];
      }
      // skipBytes >= entire chunk — skip it entirely
      return result.slice(1);
    }

    return result;
  };

  const write = (content: string): number => {
    const now = Date.now();
    const contentByteLength = encoder.encode(content).byteLength;

    // Split oversized writes into bounded chunks so eviction can reclaim memory.
    // Without this, a single write larger than maxBytes would bypass the cap.
    // Split by UTF-8 byte length, not char indices, to respect the byte cap.
    if (contentByteLength > maxBytes) {
      const encoded = encoder.encode(content);
      const decoder = new TextDecoder();
      // let justified: bytePos advances through the encoded byte array
      let bytePos = 0;
      while (bytePos < encoded.byteLength) {
        const sliceEnd = Math.min(bytePos + maxBytes, encoded.byteLength);
        const sliceBytes = encoded.slice(bytePos, sliceEnd);
        const sliceContent = decoder.decode(sliceBytes, {
          stream: bytePos + maxBytes < encoded.byteLength,
        });
        writeChunk(sliceContent, now);
        bytePos = sliceEnd;
      }
    } else {
      writeChunk(content, now);
    }

    return totalBytes;
  };

  const writeChunk = (content: string, timestamp: number): void => {
    const bytes = encoder.encode(content).byteLength;
    const chunk: OutputChunk = {
      offset: totalBytes,
      content,
      byteLength: bytes,
      timestamp,
    };
    chunks.push(chunk);
    totalBytes += bytes;
    bufferedBytes += bytes;

    evict();

    // Error isolation: one listener throwing must not break others or stop output capture
    for (const listener of listeners) {
      try {
        listener(chunk);
      } catch {
        // Swallow — subscriber errors must not disrupt the output pipeline
      }
    }
  };

  const subscribe = (listener: (chunk: OutputChunk) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const dispose = (): void => {
    chunks.length = 0;
    headIndex = 0;
    totalBytes = 0;
    bufferedBytes = 0;
    listeners.clear();
  };

  return {
    length: () => totalBytes,
    read,
    write,
    subscribe,
    [Symbol.dispose]: dispose,
  };
}
