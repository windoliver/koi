/**
 * Bounded write buffer for coalescing scratchpad writes.
 *
 * Stores pending writes in a local Map. Only the final state per path
 * is flushed to the backend (last-write-wins within a turn).
 */

import type {
  AgentGroupId,
  AgentId,
  KoiError,
  Result,
  ScratchpadGeneration,
  ScratchpadPath,
  ScratchpadWriteResult,
} from "@koi/core";
import { MAX_BUFFER_SIZE } from "./constants.js";
import type { ScratchpadClient } from "./scratchpad-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BufferedWrite {
  readonly path: ScratchpadPath;
  readonly content: string;
  readonly expectedGeneration?: ScratchpadGeneration | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Result of a flush cycle — reports which paths succeeded and which failed. */
export interface FlushResult {
  readonly succeeded: readonly ScratchpadPath[];
  readonly failed: readonly ScratchpadPath[];
}

export interface WriteBuffer {
  /** Buffer a write. Returns optimistic success. Forces flush if buffer is full. */
  readonly add: (write: BufferedWrite) => Promise<Result<ScratchpadWriteResult, KoiError>>;
  /** Flush all buffered writes to the backend. Returns succeeded/failed paths. */
  readonly flush: () => Promise<FlushResult>;
  /** Check if a path has a pending write. */
  readonly has: (path: ScratchpadPath) => boolean;
  /** Get a pending write by path (for read-your-writes). */
  readonly get: (path: ScratchpadPath) => BufferedWrite | undefined;
  /** Number of buffered writes. */
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a write buffer that coalesces writes and flushes to a ScratchpadClient. */
export function createWriteBuffer(
  client: ScratchpadClient,
  groupId: AgentGroupId,
  authorId: AgentId,
): WriteBuffer {
  // let justified: mutable buffer map, mutated on add/flush
  const buffer = new Map<ScratchpadPath, BufferedWrite>();

  async function flush(): Promise<FlushResult> {
    if (buffer.size === 0) return { succeeded: [], failed: [] };

    // Snapshot to avoid re-entrancy issues
    const entries = [...buffer.entries()];
    const succeeded: ScratchpadPath[] = [];
    const failed: ScratchpadPath[] = [];

    // Clear before persisting so concurrent adds go into a fresh buffer
    buffer.clear();

    for (const [path, write] of entries) {
      const result = await client.write(
        groupId,
        authorId,
        write.path,
        write.content,
        write.expectedGeneration,
        write.ttlSeconds,
        write.metadata,
      );
      if (!result.ok) {
        failed.push(path);
        // Re-buffer failed writes so they are retried on the next flush
        if (!buffer.has(path)) {
          buffer.set(path, write);
        }
      } else {
        succeeded.push(path);
      }
    }

    return { succeeded, failed };
  }

  return {
    add: async (write) => {
      buffer.set(write.path, write);

      // Force flush if buffer exceeds maximum
      if (buffer.size >= MAX_BUFFER_SIZE) {
        await flush();
      }

      // Return optimistic result (actual generation determined on flush)
      return {
        ok: true,
        value: {
          path: write.path,
          generation: (write.expectedGeneration ?? 0) + 1,
          sizeBytes: new TextEncoder().encode(write.content).byteLength,
        },
      };
    },

    flush,

    has: (path) => buffer.has(path),

    get: (path) => buffer.get(path),

    size: () => buffer.size,
  };
}
