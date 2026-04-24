import type {
  AgentGroupId,
  AgentId,
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadFilter,
  ScratchpadGeneration,
  ScratchpadPath,
  ScratchpadWriteInput,
  ScratchpadWriteResult,
} from "@koi/core";
import { RETRYABLE_DEFAULTS, SCRATCHPAD_DEFAULTS } from "@koi/core";

export interface LocalScratchpadConfig {
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
  readonly sweepIntervalMs?: number;
}

interface MutableEntry {
  path: ScratchpadPath;
  content: string;
  generation: ScratchpadGeneration;
  groupId: AgentGroupId;
  authorId: AgentId;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
  ttlSeconds?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

/** Concrete sync-only local scratchpad. Satisfies ScratchpadComponent (which allows T | Promise<T>). */
export interface LocalScratchpad {
  readonly write: (input: ScratchpadWriteInput) => Result<ScratchpadWriteResult, KoiError>;
  readonly read: (path: ScratchpadPath) => Result<ScratchpadEntry, KoiError>;
  readonly list: (filter?: ScratchpadFilter) => readonly ScratchpadEntrySummary[];
  readonly delete: (path: ScratchpadPath) => Result<void, KoiError>;
  readonly flush: () => void;
  readonly onChange: (handler: (event: ScratchpadChangeEvent) => void) => () => void;
  readonly close: () => void;
}

// Deep-clone via JSON round-trip: constrains metadata to JSON-safe primitives
// and breaks all shared references so stored state cannot be mutated out-of-band.
function cloneMetadata(m: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
}

function toEntry(m: MutableEntry): ScratchpadEntry {
  return {
    path: m.path,
    content: m.content,
    generation: m.generation,
    groupId: m.groupId,
    authorId: m.authorId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    sizeBytes: m.sizeBytes,
    ...(m.ttlSeconds !== undefined ? { ttlSeconds: m.ttlSeconds } : {}),
    ...(m.metadata !== undefined ? { metadata: cloneMetadata(m.metadata) } : {}),
  };
}

function toSummary(m: MutableEntry): ScratchpadEntrySummary {
  return {
    path: m.path,
    generation: m.generation,
    groupId: m.groupId,
    authorId: m.authorId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    sizeBytes: m.sizeBytes,
    ...(m.ttlSeconds !== undefined ? { ttlSeconds: m.ttlSeconds } : {}),
    ...(m.metadata !== undefined ? { metadata: cloneMetadata(m.metadata) } : {}),
  };
}

function isExpired(entry: MutableEntry): boolean {
  return entry.expiresAt !== undefined && Date.now() >= entry.expiresAt;
}

function validatePath(path: ScratchpadPath): KoiError | null {
  if (!path || path.length === 0) {
    return { code: "VALIDATION", message: "Scratchpad path must not be empty", retryable: false };
  }
  if (path.startsWith("/")) {
    return {
      code: "VALIDATION",
      message: "Scratchpad path must not start with '/'",
      retryable: false,
    };
  }
  if (path.includes("..")) {
    return {
      code: "VALIDATION",
      message: "Scratchpad path must not contain '..'",
      retryable: false,
    };
  }
  if (path.length > SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH) {
    return {
      code: "VALIDATION",
      message: `Scratchpad path exceeds max length of ${SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH}`,
      retryable: false,
    };
  }
  return null;
}

function matchesGlob(glob: string, path: string): boolean {
  return new Bun.Glob(glob).match(path);
}

const CLOSED_ERROR: KoiError = {
  code: "VALIDATION",
  message: "Scratchpad is closed",
  retryable: false,
};

export function createLocalScratchpad(config: LocalScratchpadConfig): LocalScratchpad {
  const { groupId, authorId } = config;
  const sweepIntervalMs = config.sweepIntervalMs ?? 60_000;

  const entries = new Map<ScratchpadPath, MutableEntry>();
  const subscribers = new Set<(event: ScratchpadChangeEvent) => void>();
  let closed = false;

  function notify(event: ScratchpadChangeEvent): void {
    for (const sub of subscribers) {
      try {
        sub(event);
      } catch {
        // Observer errors must not escape after mutation has committed
      }
    }
  }

  function sweep(): void {
    for (const [path, entry] of entries) {
      if (isExpired(entry)) entries.delete(path);
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (sweepIntervalMs > 0) {
    timer = setInterval(sweep, sweepIntervalMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  function write(input: ScratchpadWriteInput): Result<ScratchpadWriteResult, KoiError> {
    if (closed) return { ok: false, error: CLOSED_ERROR };
    const pathErr = validatePath(input.path);
    if (pathErr) return { ok: false, error: pathErr };

    const sizeBytes = new TextEncoder().encode(input.content).byteLength;
    if (sizeBytes > SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_EXHAUSTED",
          message: `Content size ${sizeBytes} exceeds limit ${SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES}`,
          retryable: RETRYABLE_DEFAULTS.RESOURCE_EXHAUSTED,
        },
      };
    }

    const existing = entries.get(input.path);
    const liveExisting = existing && !isExpired(existing) ? existing : undefined;

    if (input.expectedGeneration === 0) {
      if (liveExisting) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Path '${input.path}' already exists`,
            retryable: RETRYABLE_DEFAULTS.CONFLICT,
          },
        };
      }
    } else if (input.expectedGeneration !== undefined) {
      if (!liveExisting) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Path '${input.path}' not found`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          },
        };
      }
      if (liveExisting.generation !== input.expectedGeneration) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Generation mismatch: expected ${input.expectedGeneration}, got ${liveExisting.generation}`,
            retryable: RETRYABLE_DEFAULTS.CONFLICT,
          },
        };
      }
    }

    // Check file limit (sweep first to avoid false rejections)
    if (!liveExisting) {
      sweep();
      if (entries.size >= SCRATCHPAD_DEFAULTS.MAX_FILES_PER_GROUP) {
        return {
          ok: false,
          error: {
            code: "RESOURCE_EXHAUSTED",
            message: `File count limit ${SCRATCHPAD_DEFAULTS.MAX_FILES_PER_GROUP} reached`,
            retryable: RETRYABLE_DEFAULTS.RESOURCE_EXHAUSTED,
          },
        };
      }
    }

    const now = new Date().toISOString();
    const generation = (liveExisting?.generation ?? 0) + 1;

    const entry: MutableEntry = {
      path: input.path,
      content: input.content,
      generation,
      groupId,
      authorId,
      createdAt: liveExisting?.createdAt ?? now,
      updatedAt: now,
      sizeBytes,
      ...(input.ttlSeconds !== undefined
        ? { ttlSeconds: input.ttlSeconds, expiresAt: Date.now() + input.ttlSeconds * 1000 }
        : {}),
      // Deep-clone + freeze on write: severs all caller references, including nested objects
      ...(input.metadata !== undefined
        ? { metadata: Object.freeze(cloneMetadata(input.metadata)) as Record<string, unknown> }
        : {}),
    };

    entries.set(input.path, entry);

    notify({ kind: "written", path: input.path, generation, authorId, groupId, timestamp: now });

    return { ok: true, value: { path: input.path, generation, sizeBytes } };
  }

  function read(path: ScratchpadPath): Result<ScratchpadEntry, KoiError> {
    if (closed) return { ok: false, error: CLOSED_ERROR };
    const entry = entries.get(path);
    if (!entry || isExpired(entry)) {
      if (entry) entries.delete(path);
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Path '${path}' not found`, retryable: false },
      };
    }
    return { ok: true, value: toEntry(entry) };
  }

  function list(filter?: ScratchpadFilter): readonly ScratchpadEntrySummary[] {
    if (closed) return [];
    const now = Date.now();
    let results: ScratchpadEntrySummary[] = [];

    for (const [path, entry] of entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        entries.delete(path);
        continue;
      }
      if (filter?.authorId !== undefined && entry.authorId !== filter.authorId) continue;
      if (filter?.glob !== undefined && !matchesGlob(filter.glob, entry.path)) continue;
      results.push(toSummary(entry));
    }

    if (filter?.limit !== undefined) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  function del(path: ScratchpadPath): Result<void, KoiError> {
    if (closed) return { ok: false, error: CLOSED_ERROR };
    const entry = entries.get(path);
    if (!entry || isExpired(entry)) {
      if (entry) entries.delete(path);
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Path '${path}' not found`, retryable: false },
      };
    }
    const { generation } = entry;
    entries.delete(path);
    const now = new Date().toISOString();
    notify({
      kind: "deleted",
      path,
      generation,
      authorId: entry.authorId,
      groupId: entry.groupId,
      timestamp: now,
    });
    return { ok: true, value: undefined };
  }

  function flush(): void {
    // No-op for in-memory backend
  }

  function onChange(handler: (event: ScratchpadChangeEvent) => void): () => void {
    if (closed) return () => {};
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  function close(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    entries.clear();
    subscribers.clear();
    closed = true;
  }

  return { write, read, list, delete: del, flush, onChange, close };
}
