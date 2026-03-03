/**
 * Local in-memory ScratchpadComponent implementation.
 *
 * Features:
 * - CAS write semantics (create-only, conditional update, unconditional)
 * - TTL with lazy eviction on read/list + periodic sweep
 * - Path validation (no "..", no leading "/", max length)
 * - File count and size limits
 * - Change event subscribers
 */

import type {
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
import { RETRYABLE_DEFAULTS, SCRATCHPAD_DEFAULTS } from "@koi/core";
import type { LocalScratchpadConfig } from "./types.js";
import { validatePath } from "./validate-path.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Internal mutable entry (never exposed — cloned on read). */
interface MutableEntry {
  readonly path: ScratchpadPath;
  content: string;
  generation: number;
  readonly groupId: string;
  readonly authorId: string;
  readonly createdAt: string;
  updatedAt: string;
  sizeBytes: number;
  ttlSeconds: number | undefined;
  expiresAt: number | undefined;
  metadata: Readonly<Record<string, unknown>> | undefined;
}

/** Simple glob matching supporting * and ** patterns. */
function matchGlob(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

/**
 * Create a local in-memory ScratchpadComponent.
 */
export function createLocalScratchpad(config: LocalScratchpadConfig): ScratchpadComponent & {
  /** Close the scratchpad, clearing the sweep timer and all entries. */
  readonly close: () => void;
} {
  const entries = new Map<string, MutableEntry>();
  const subscribers = new Set<(event: ScratchpadChangeEvent) => void>();
  // let justified: generation counter increments on each write
  let nextGeneration = 1;

  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const sweepTimer = setInterval(() => sweep(), sweepIntervalMs);
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref();
  }

  function isExpired(entry: MutableEntry): boolean {
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
  }

  function sweep(): void {
    for (const [key, entry] of entries) {
      if (isExpired(entry)) {
        entries.delete(key);
      }
    }
  }

  function toReadonly(entry: MutableEntry): ScratchpadEntry {
    return {
      path: entry.path,
      content: entry.content,
      generation: entry.generation,
      groupId: entry.groupId as ScratchpadEntry["groupId"],
      authorId: entry.authorId as ScratchpadEntry["authorId"],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sizeBytes: entry.sizeBytes,
      ...(entry.ttlSeconds !== undefined ? { ttlSeconds: entry.ttlSeconds } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    };
  }

  function toSummary(entry: MutableEntry): ScratchpadEntrySummary {
    return {
      path: entry.path,
      generation: entry.generation,
      groupId: entry.groupId as ScratchpadEntrySummary["groupId"],
      authorId: entry.authorId as ScratchpadEntrySummary["authorId"],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sizeBytes: entry.sizeBytes,
      ...(entry.ttlSeconds !== undefined ? { ttlSeconds: entry.ttlSeconds } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    };
  }

  function notify(event: ScratchpadChangeEvent): void {
    for (const handler of subscribers) {
      handler(event);
    }
  }

  return {
    write(input: ScratchpadWriteInput): Result<ScratchpadWriteResult, KoiError> {
      // Validate path
      const pathResult = validatePath(input.path);
      if (!pathResult.ok) return pathResult;

      // Validate content size
      const sizeBytes = new TextEncoder().encode(input.content).byteLength;
      if (sizeBytes > SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Content exceeds max file size (${sizeBytes} > ${SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES})`,
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }

      const existing = entries.get(input.path);
      const existingValid = existing !== undefined && !isExpired(existing);

      // CAS semantics
      if (input.expectedGeneration === 0) {
        // Create-only
        if (existingValid) {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Path already exists: "${input.path}"`,
              retryable: RETRYABLE_DEFAULTS.CONFLICT,
            },
          };
        }
      } else if (input.expectedGeneration !== undefined) {
        // CAS update — generation must match
        if (!existingValid) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Path not found for CAS update: "${input.path}"`,
              retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
            },
          };
        }
        if (existing.generation !== input.expectedGeneration) {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Generation mismatch: expected ${input.expectedGeneration}, got ${existing.generation}`,
              retryable: RETRYABLE_DEFAULTS.CONFLICT,
            },
          };
        }
      }

      // Check file count limit (only for new entries)
      if (!existingValid && entries.size >= SCRATCHPAD_DEFAULTS.MAX_FILES_PER_GROUP) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `File count limit exceeded (${SCRATCHPAD_DEFAULTS.MAX_FILES_PER_GROUP})`,
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }

      const now = new Date().toISOString();
      const generation = nextGeneration++;
      const expiresAt =
        input.ttlSeconds !== undefined ? Date.now() + input.ttlSeconds * 1000 : undefined;

      if (existingValid && existing !== undefined) {
        // Update existing entry
        existing.content = input.content;
        existing.generation = generation;
        existing.updatedAt = now;
        existing.sizeBytes = sizeBytes;
        existing.ttlSeconds = input.ttlSeconds;
        existing.expiresAt = expiresAt;
        existing.metadata = input.metadata;
      } else {
        // Clean up expired entry if present
        if (existing !== undefined) {
          entries.delete(input.path);
        }
        // Create new entry
        const entry: MutableEntry = {
          path: input.path,
          content: input.content,
          generation,
          groupId: config.groupId,
          authorId: config.authorId,
          createdAt: now,
          updatedAt: now,
          sizeBytes,
          ttlSeconds: input.ttlSeconds,
          expiresAt,
          metadata: input.metadata,
        };
        entries.set(input.path, entry);
      }

      notify({
        kind: "written",
        path: input.path,
        generation,
        authorId: config.authorId,
        groupId: config.groupId,
        timestamp: now,
      });

      return {
        ok: true,
        value: { path: input.path, generation, sizeBytes },
      };
    },

    read(path: ScratchpadPath): Result<ScratchpadEntry, KoiError> {
      const entry = entries.get(path);
      if (entry === undefined || isExpired(entry)) {
        if (entry !== undefined) entries.delete(path); // Lazy eviction
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Path not found: "${path}"`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          },
        };
      }
      return { ok: true, value: toReadonly(entry) };
    },

    list(filter?: ScratchpadFilter): readonly ScratchpadEntrySummary[] {
      const result: ScratchpadEntrySummary[] = [];
      for (const [key, entry] of entries) {
        if (isExpired(entry)) {
          entries.delete(key);
          continue;
        }
        if (filter?.glob !== undefined && !matchGlob(filter.glob, entry.path)) {
          continue;
        }
        if (filter?.authorId !== undefined && entry.authorId !== filter.authorId) {
          continue;
        }
        result.push(toSummary(entry));
        if (filter?.limit !== undefined && result.length >= filter.limit) {
          break;
        }
      }
      return result;
    },

    delete(path: ScratchpadPath): Result<void, KoiError> {
      const entry = entries.get(path);
      if (entry === undefined || isExpired(entry)) {
        if (entry !== undefined) entries.delete(path);
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Path not found: "${path}"`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          },
        };
      }

      const generation = entry.generation;
      entries.delete(path);

      notify({
        kind: "deleted",
        path,
        generation,
        authorId: config.authorId,
        groupId: config.groupId,
        timestamp: new Date().toISOString(),
      });

      return { ok: true, value: undefined };
    },

    flush(): void {
      // No-op for in-memory — all writes are immediate
    },

    onChange(handler: (event: ScratchpadChangeEvent) => void): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    close(): void {
      clearInterval(sweepTimer);
      entries.clear();
      subscribers.clear();
    },
  };
}
