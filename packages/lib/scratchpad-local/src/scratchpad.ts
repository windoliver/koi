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
  /**
   * How long (ms) to retain a dormant group store after the last handle closes.
   * Defaults to 0 (immediate eviction) to prevent cross-lifecycle state leaks when
   * a groupId is recycled. Set to a positive value only when cross-turn state sharing
   * is intentional and the groupId is guaranteed to be unique per agent lifecycle.
   */
  readonly dormantTtlMs?: number;
  /**
   * Opaque token that authorizes reuse of a dormant store (dormantTtlMs > 0).
   * A new handle that presents the same token as the store was created with may
   * reuse the existing entries. A handle without a matching token evicts the dormant
   * store and starts fresh, preventing a recycled groupId from inheriting prior
   * lifecycle state. Leave undefined when dormantTtlMs is 0 (the default).
   */
  readonly reuseToken?: string;
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

// Process-wide shared storage keyed by groupId so all scratchpad instances within
// the same group observe each other's writes, CAS conflicts, and change events.
interface GroupStore {
  entries: Map<ScratchpadPath, MutableEntry>;
  // Keyed by unique symbol per registration so the same function from two handles
  // gets two independent entries — preventing one handle's close from silently
  // unregistering another handle's listener.
  subscribers: Map<symbol, (event: ScratchpadChangeEvent) => void>;
  refCount: number;
  timer: ReturnType<typeof setInterval> | null;
  dormantTimer: ReturnType<typeof setTimeout> | null;
  /** Fixed at store creation (first-handle-wins). All handles in the group share this TTL. */
  readonly dormantTtlMs: number;
  /**
   * Token set at store creation. Only a handle that presents this exact token may
   * reuse a dormant store; any other opener causes the dormant store to be evicted.
   */
  readonly reuseToken: string | null;
}

const groupRegistry = new Map<string, GroupStore>();

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

  let sharedStore = groupRegistry.get(groupId as string);

  if (sharedStore !== undefined) {
    const callerToken = config.reuseToken ?? null;

    if (sharedStore.dormantTimer !== null) {
      // Dormant store: reject callers with a mismatched or absent token.
      // Evicting would destroy state the original owner expects to reclaim within dormantTtlMs.
      // The dormant TTL will naturally expire the store; rejected callers must use a different
      // groupId or wait. Only evict-and-replace when the token matches (legitimate reopen).
      if (sharedStore.reuseToken !== null && callerToken !== sharedStore.reuseToken) {
        throw new Error(
          `Scratchpad group "${groupId}" is dormant and owned by a different reuseToken`,
        );
      }
    } else if (sharedStore.reuseToken !== null && callerToken !== sharedStore.reuseToken) {
      // Active store with a reuseToken fence: ALL new handles must present the exact token,
      // including handles with no token (null). A recycled lifecycle that lost or never had
      // the token must not inherit the live store's state — the reuseToken IS the credential
      // for joining a tokenized group.
      throw new Error(`Scratchpad group "${groupId}" is already open with a different reuseToken`);
    }
  }

  if (sharedStore === undefined) {
    sharedStore = {
      entries: new Map(),
      subscribers: new Map(),
      refCount: 0,
      timer: null,
      dormantTimer: null,
      // Default 0 = evict immediately when last handle closes (opt-in retention via dormantTtlMs).
      // Non-zero values allow cross-turn state sharing but risk leaking into a later
      // group that reuses the same groupId — callers must use stable, unique groupIds.
      dormantTtlMs: config.dormantTtlMs ?? 0,
      reuseToken: config.reuseToken ?? null,
    };
    groupRegistry.set(groupId as string, sharedStore);
  }
  // Cancel any pending dormant eviction — a new handle is reopening this group.
  if (sharedStore.dormantTimer !== null) {
    clearTimeout(sharedStore.dormantTimer);
    sharedStore.dormantTimer = null;
  }
  // (Re)start sweep timer when a new handle joins a dormant group.
  if (sharedStore.timer === null && sweepIntervalMs > 0) {
    const dormantStore = sharedStore;
    const t = setInterval(() => {
      for (const [path, entry] of dormantStore.entries) {
        if (isExpired(entry)) dormantStore.entries.delete(path);
      }
    }, sweepIntervalMs);
    if (t && typeof t === "object" && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
    sharedStore.timer = t;
  }
  sharedStore.refCount++;
  const store = sharedStore;

  let closed = false;
  // Per-registration tokens for this handle — symbol keys match store.subscribers entries.
  // Using symbol tokens (not function identity) means two handles registering the same
  // function get independent entries; closing one handle never removes the other's listener.
  const instanceTokens = new Set<symbol>();

  function notify(event: ScratchpadChangeEvent): void {
    for (const sub of store.subscribers.values()) {
      try {
        sub(event);
      } catch {
        // Observer errors must not escape after mutation has committed
      }
    }
  }

  function sweep(): void {
    for (const [path, entry] of store.entries) {
      if (isExpired(entry)) store.entries.delete(path);
    }
  }

  function write(input: ScratchpadWriteInput): Result<ScratchpadWriteResult, KoiError> {
    if (closed) return { ok: false, error: CLOSED_ERROR };
    const pathErr = validatePath(input.path);
    if (pathErr) return { ok: false, error: pathErr };

    if (input.ttlSeconds !== undefined) {
      if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "ttlSeconds must be a finite positive number",
            retryable: false,
          },
        };
      }
    }

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

    const existing = store.entries.get(input.path);
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
      if (store.entries.size >= SCRATCHPAD_DEFAULTS.MAX_FILES_PER_GROUP) {
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

    let clonedMetadata: Record<string, unknown> | undefined;
    if (input.metadata !== undefined) {
      try {
        clonedMetadata = Object.freeze(cloneMetadata(input.metadata)) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "Metadata must be JSON-serializable (no circular references, BigInt, or functions)",
            retryable: false,
          },
        };
      }
    }

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
      ...(clonedMetadata !== undefined ? { metadata: clonedMetadata } : {}),
    };

    store.entries.set(input.path, entry);

    notify({ kind: "written", path: input.path, generation, authorId, groupId, timestamp: now });

    return { ok: true, value: { path: input.path, generation, sizeBytes } };
  }

  function read(path: ScratchpadPath): Result<ScratchpadEntry, KoiError> {
    if (closed) return { ok: false, error: CLOSED_ERROR };
    const entry = store.entries.get(path);
    if (!entry || isExpired(entry)) {
      if (entry) store.entries.delete(path);
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

    for (const [path, entry] of store.entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        store.entries.delete(path);
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
    const entry = store.entries.get(path);
    if (!entry || isExpired(entry)) {
      if (entry) store.entries.delete(path);
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Path '${path}' not found`, retryable: false },
      };
    }
    const { generation } = entry;
    store.entries.delete(path);
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
    const token = Symbol();
    instanceTokens.add(token);
    store.subscribers.set(token, handler);
    return () => {
      instanceTokens.delete(token);
      store.subscribers.delete(token);
    };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // Remove only this handle's subscriptions — token-keyed so other handles
    // registering the same function are unaffected.
    for (const token of instanceTokens) {
      store.subscribers.delete(token);
    }
    instanceTokens.clear();
    store.refCount--;
    if (store.refCount <= 0) {
      if (store.timer !== null) clearInterval(store.timer);
      store.timer = null;
      // Schedule bounded eviction so dormant groups don't leak indefinitely.
      // Any new handle opening for the same groupId cancels this timer.
      const evict = (): void => {
        store.entries.clear();
        groupRegistry.delete(groupId as string);
      };
      if (store.dormantTtlMs <= 0) {
        evict();
      } else {
        const dt = setTimeout(evict, store.dormantTtlMs);
        if (dt && typeof dt === "object" && "unref" in dt) {
          (dt as { unref: () => void }).unref();
        }
        store.dormantTimer = dt;
      }
    }
  }

  return { write, read, list, delete: del, flush, onChange, close };
}
