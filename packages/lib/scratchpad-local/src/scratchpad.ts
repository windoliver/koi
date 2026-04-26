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

// Process-wide memory limits — prevent a runaway caller from OOMing the host by
// fanning out across many group IDs. Per-group limits (MAX_FILES_PER_GROUP,
// MAX_FILE_SIZE_BYTES) are enforced per write; these caps cover the global surface.
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB across all groups
const MAX_TOTAL_GROUPS = 500;
// let: mutated by write/delete/sweep/eviction — must remain consistent across all paths
let totalBytesUsed = 0;

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
      if (sharedStore.reuseToken === null) {
        // No token was set on the dormant store: there is no credential to verify a reopener,
        // so any opener gets a fresh store. This prevents cross-lifecycle state leaks via
        // recyclable or guessable groupIds when dormantTtlMs retention was enabled carelessly.
        // Refund the byte budget before evicting — the entries are being discarded.
        for (const entry of sharedStore.entries.values()) {
          totalBytesUsed -= entry.sizeBytes;
        }
        clearTimeout(sharedStore.dormantTimer);
        if (sharedStore.timer !== null) clearInterval(sharedStore.timer);
        groupRegistry.delete(groupId as string);
        sharedStore = undefined;
      } else if (callerToken !== sharedStore.reuseToken) {
        // Token mismatch: reject without destroying dormant state.
        // The original owner should be able to reclaim within dormantTtlMs.
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
    } else if (callerToken !== null && sharedStore.reuseToken === null) {
      // Caller expects token isolation but the active store was opened without a token.
      // Admitting a token-bearing caller to a tokenless store silently degrades isolation:
      // any earlier tokenless opener shares the same live state. Reject instead of downgrading.
      throw new Error(
        `Scratchpad group "${groupId}" is already open without a reuseToken; a token-bearing caller cannot join it`,
      );
    }
  }

  if (sharedStore === undefined) {
    if (groupRegistry.size >= MAX_TOTAL_GROUPS) {
      throw new Error(
        `Process-wide scratchpad group limit of ${MAX_TOTAL_GROUPS} reached; cannot open group "${groupId}"`,
      );
    }
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
        if (isExpired(entry)) {
          totalBytesUsed -= entry.sizeBytes;
          dormantStore.entries.delete(path);
        }
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
      if (isExpired(entry)) {
        totalBytesUsed -= entry.sizeBytes;
        store.entries.delete(path);
      }
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

    // Serialize metadata first so its bytes are included in size accounting.
    // This prevents callers from bypassing the per-file and process-wide limits
    // by submitting tiny content paired with very large metadata objects.
    let clonedMetadata: Record<string, unknown> | undefined;
    let metadataBytes = 0;
    if (input.metadata !== undefined) {
      try {
        clonedMetadata = Object.freeze(cloneMetadata(input.metadata)) as Record<string, unknown>;
        metadataBytes = new TextEncoder().encode(JSON.stringify(clonedMetadata)).byteLength;
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

    const sizeBytes = new TextEncoder().encode(input.content).byteLength + metadataBytes;
    if (sizeBytes > SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_EXHAUSTED",
          message: `Entry size ${sizeBytes} exceeds limit ${SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES}`,
          retryable: RETRYABLE_DEFAULTS.RESOURCE_EXHAUSTED,
        },
      };
    }

    const existing = store.entries.get(input.path);
    const liveExisting = existing && !isExpired(existing) ? existing : undefined;

    // Expired entry at this path still occupies bytes in totalBytesUsed — reclaim them now
    // so the subsequent byteDelta doesn't treat the path as free space while the old bytes
    // remain counted. The store.entries.set() below will write a fresh entry in its place.
    if (existing && !liveExisting) {
      totalBytesUsed -= existing.sizeBytes;
      store.entries.delete(input.path);
    }

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

    // Check process-wide byte budget before committing.
    const byteDelta = sizeBytes - (liveExisting?.sizeBytes ?? 0);
    if (byteDelta > 0 && totalBytesUsed + byteDelta > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_EXHAUSTED",
          message: `Process-wide scratchpad byte budget of ${MAX_TOTAL_BYTES} bytes exceeded`,
          retryable: RETRYABLE_DEFAULTS.RESOURCE_EXHAUSTED,
        },
      };
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
      ...(clonedMetadata !== undefined ? { metadata: clonedMetadata } : {}),
    };

    store.entries.set(input.path, entry);
    totalBytesUsed += byteDelta;

    notify({ kind: "written", path: input.path, generation, authorId, groupId, timestamp: now });

    return { ok: true, value: { path: input.path, generation, sizeBytes } };
  }

  function read(path: ScratchpadPath): Result<ScratchpadEntry, KoiError> {
    if (closed) return { ok: false, error: CLOSED_ERROR };
    const entry = store.entries.get(path);
    if (!entry || isExpired(entry)) {
      if (entry) {
        totalBytesUsed -= entry.sizeBytes;
        store.entries.delete(path);
      }
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
        totalBytesUsed -= entry.sizeBytes;
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
      if (entry) {
        totalBytesUsed -= entry.sizeBytes;
        store.entries.delete(path);
      }
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Path '${path}' not found`, retryable: false },
      };
    }
    const { generation } = entry;
    totalBytesUsed -= entry.sizeBytes;
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
        for (const e of store.entries.values()) {
          totalBytesUsed -= e.sizeBytes;
        }
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
