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

export interface WriteBuffer {
  /** Buffer a write. Returns optimistic success. Forces flush if buffer is full. */
  readonly add: (write: BufferedWrite) => Promise<Result<ScratchpadWriteResult, KoiError>>;
  /** Flush all buffered writes to the backend. */
  readonly flush: () => Promise<void>;
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

  async function flush(): Promise<void> {
    if (buffer.size === 0) return;

    // Snapshot and clear to avoid re-entrancy issues
    const entries = [...buffer.entries()];
    buffer.clear();

    for (const [, write] of entries) {
      await client.write(
        groupId,
        authorId,
        write.path,
        write.content,
        write.expectedGeneration,
        write.ttlSeconds,
        write.metadata,
      );
    }
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
