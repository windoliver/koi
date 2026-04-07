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
  const maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES;

  let chunks: OutputChunk[] = [];
  let totalBytes = 0;
  let bufferedBytes = 0;
  const listeners = new Set<(chunk: OutputChunk) => void>();

  const evict = (): void => {
    while (bufferedBytes > maxBytes && chunks.length > 1) {
      const evicted = chunks[0]!;
      chunks = chunks.slice(1);
      bufferedBytes -= evicted.byteLength;
    }
  };

  /**
   * Binary search for the first chunk whose offset >= targetOffset.
   * Chunks are sorted by offset (monotonically increasing).
   */
  const findStartIndex = (targetOffset: number): number => {
    let lo = 0;
    let hi = chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (chunks[mid]!.offset + chunks[mid]!.byteLength <= targetOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const read = (fromOffset: number): readonly OutputChunk[] => {
    if (chunks.length === 0) return [];
    const idx = findStartIndex(fromOffset);
    if (idx >= chunks.length) return [];

    const result = chunks.slice(idx);

    // If the requested offset falls mid-chunk, trim the first chunk
    // to only include content after the offset. This prevents duplicate
    // data when callers resume from an arbitrary byte position.
    const first = result[0];
    if (first !== undefined && first.offset < fromOffset) {
      const skipBytes = fromOffset - first.offset;
      // Decode and re-encode to find the character boundary at skipBytes
      const encoded = encoder.encode(first.content);
      if (skipBytes < encoded.byteLength) {
        const trimmedBytes = encoded.slice(skipBytes);
        const trimmedContent = new TextDecoder().decode(trimmedBytes);
        const trimmed: OutputChunk = {
          offset: fromOffset,
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
    if (contentByteLength > maxBytes) {
      // let justified: index advances through the oversized content
      let pos = 0;
      while (pos < content.length) {
        // Approximate char-level split; actual byte accounting is per-chunk
        const slice = content.slice(pos, pos + maxBytes);
        writeChunk(slice, now);
        pos += maxBytes;
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

    for (const listener of listeners) {
      listener(chunk);
    }
  };

  const subscribe = (listener: (chunk: OutputChunk) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const dispose = (): void => {
    chunks = [];
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
