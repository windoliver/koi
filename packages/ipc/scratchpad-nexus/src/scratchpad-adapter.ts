/**
 * ScratchpadComponent factory — owns write buffer + generation cache.
 *
 * Implements the ScratchpadComponent interface from @koi/core with:
 * - Client-side write buffering (flush-on-read, flush-on-turn-boundary)
 * - Generation-based conditional reads (cache + generation check)
 * - Change event subscription via polling (Nexus push not yet available)
 */

import type {
  AgentGroupId,
  AgentId,
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadComponent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadFilter,
  ScratchpadPath,
  ScratchpadWriteInput,
  ScratchpadWriteResult,
} from "@koi/core";
import { SCRATCHPAD_DEFAULTS } from "@koi/core";
import type { GenerationCache } from "./generation-cache.js";
import type { ScratchpadClient } from "./scratchpad-client.js";
import type { WriteBuffer } from "./write-buffer.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ScratchpadAdapterConfig {
  readonly client: ScratchpadClient;
  readonly writeBuffer: WriteBuffer;
  readonly generationCache: GenerationCache;
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a ScratchpadComponent backed by Nexus RPC with write buffering and caching. */
export function createScratchpadAdapter(config: ScratchpadAdapterConfig): ScratchpadComponent {
  const { client, writeBuffer, generationCache, groupId, authorId } = config;

  // let justified: mutable listener set for onChange notifications
  const listeners = new Set<(event: ScratchpadChangeEvent) => void>();

  function notifyListeners(event: ScratchpadChangeEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  return {
    write: async (
      input: ScratchpadWriteInput,
    ): Promise<Result<ScratchpadWriteResult, KoiError>> => {
      // Validate path
      if (input.path.length === 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Scratchpad path must not be empty",
            retryable: false,
          },
        };
      }
      if (input.path.length > SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Scratchpad path exceeds maximum length of ${String(SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH)}`,
            retryable: false,
          },
        };
      }
      if (input.path.includes("..")) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Scratchpad path must not contain '..'",
            retryable: false,
          },
        };
      }
      if (input.path.startsWith("/")) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Scratchpad path must not start with '/'",
            retryable: false,
          },
        };
      }

      // Validate content size
      const sizeBytes = new TextEncoder().encode(input.content).byteLength;
      if (sizeBytes > SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Content exceeds maximum size of ${String(SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES)} bytes`,
            retryable: false,
          },
        };
      }

      // Buffer the write
      const result = await writeBuffer.add({
        path: input.path,
        content: input.content,
        expectedGeneration: input.expectedGeneration,
        ttlSeconds: input.ttlSeconds,
        metadata: input.metadata,
      });

      if (result.ok) {
        // Invalidate cache for this path
        generationCache.invalidate(input.path);

        // Notify listeners
        notifyListeners({
          kind: "written",
          path: input.path,
          generation: result.value.generation,
          authorId,
          groupId,
          timestamp: new Date().toISOString(),
        });
      }

      return result;
    },

    read: async (path: ScratchpadPath): Promise<Result<ScratchpadEntry, KoiError>> => {
      // Flush buffer first to ensure consistency
      await writeBuffer.flush();

      // Check write buffer for uncommitted data
      const buffered = writeBuffer.get(path);
      if (buffered !== undefined) {
        // Read-your-writes: return the buffered data
        // This shouldn't happen after flush, but handles edge cases
        return {
          ok: true,
          value: {
            path: buffered.path,
            content: buffered.content,
            generation: (buffered.expectedGeneration ?? 0) + 1,
            groupId,
            authorId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sizeBytes: new TextEncoder().encode(buffered.content).byteLength,
            ...(buffered.ttlSeconds !== undefined ? { ttlSeconds: buffered.ttlSeconds } : {}),
            ...(buffered.metadata !== undefined ? { metadata: buffered.metadata } : {}),
          },
        };
      }

      // Use generation cache for reads
      return generationCache.read(groupId, path);
    },

    list: async (filter?: ScratchpadFilter): Promise<readonly ScratchpadEntrySummary[]> => {
      // Flush buffer first to ensure consistency
      await writeBuffer.flush();

      const result = await client.list(groupId, filter);
      if (!result.ok) return [];
      return result.value;
    },

    delete: async (path: ScratchpadPath): Promise<Result<void, KoiError>> => {
      // Flush buffer first (path might be in buffer)
      await writeBuffer.flush();

      const result = await client.delete(groupId, path);
      if (result.ok) {
        generationCache.invalidate(path);
        notifyListeners({
          kind: "deleted",
          path,
          generation: 0,
          authorId,
          groupId,
          timestamp: new Date().toISOString(),
        });
      }
      return result;
    },

    flush: async (): Promise<void> => {
      await writeBuffer.flush();
    },

    onChange: (handler: (event: ScratchpadChangeEvent) => void): (() => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
