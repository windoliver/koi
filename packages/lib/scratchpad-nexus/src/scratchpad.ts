import type {
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadComponent,
  ScratchpadEntrySummary,
  ScratchpadFilter,
  ScratchpadPath,
  ScratchpadWriteInput,
  ScratchpadWriteResult,
} from "@koi/core";
import { SCRATCHPAD_DEFAULTS, scratchpadPath } from "@koi/core";
import { createChangeTracker } from "./change-tracker.js";
import { createNexusScratchpadClient } from "./client.js";
import { mapEntry, mapSummaries } from "./map-entry.js";
import type { NexusScratchpadConfig } from "./types.js";

const DEFAULT_PREFIX = "scratchpad";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
// Defensive cap on pagination loops so a misbehaving server (a cursor that
// never advances, returns the same token, or hands out infinite empty pages)
// cannot wedge `list()` or the change poller forever. 1024 pages × the default
// pageSize is 100k entries — well above any realistic working set, and orders
// of magnitude below "loop forever".
const MAX_PAGES_PER_DRAIN = 1024;

type ChangeHandler = (event: ScratchpadChangeEvent) => void;

// Mirror scratchpad-local's input validation so untrusted user paths/TTLs
// never cross the RPC boundary. ScratchpadPath is a structural brand (an
// identity cast), so callers can still construct values that bypass type
// checks; we re-validate at the trust boundary regardless.
function validatePath(path: ScratchpadPath): KoiError | null {
  const value = path as string;
  if (!value || value.length === 0) {
    return { code: "VALIDATION", message: "Scratchpad path must not be empty", retryable: false };
  }
  if (value.startsWith("/")) {
    return {
      code: "VALIDATION",
      message: "Scratchpad path must not start with '/'",
      retryable: false,
    };
  }
  if (value.includes("..")) {
    return {
      code: "VALIDATION",
      message: "Scratchpad path must not contain '..'",
      retryable: false,
    };
  }
  if (value.length > SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH) {
    return {
      code: "VALIDATION",
      message: `Scratchpad path exceeds max length of ${SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH}`,
      retryable: false,
    };
  }
  return null;
}

function validateTtl(ttlSeconds: number | undefined): KoiError | null {
  if (ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return {
      code: "VALIDATION",
      message: "ttlSeconds must be a finite positive number",
      retryable: false,
    };
  }
  return null;
}

// Mirror scratchpad-local's metadata clone: round-trip through JSON to
// reject non-serializable inputs (BigInt, functions, circular structures)
// at the trust boundary instead of failing deep inside RPC serialization.
function cloneMetadata(
  metadata: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: KoiError } {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown> };
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Scratchpad metadata is not JSON-serializable",
        retryable: false,
        context: { reason: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

// Enforce the contract-level entry-size cap before crossing the network so
// oversized writes fail deterministically here rather than producing
// vendor-specific errors deep in the transport layer. Matches the local
// implementation: content bytes + serialized metadata bytes.
function validateEntrySize(
  content: string,
  metadata: Record<string, unknown> | undefined,
): { ok: true; value: number } | { ok: false; error: KoiError } {
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content).byteLength;
  const metadataBytes =
    metadata !== undefined ? encoder.encode(JSON.stringify(metadata)).byteLength : 0;
  const sizeBytes = contentBytes + metadataBytes;
  if (sizeBytes > SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Entry size ${sizeBytes} exceeds limit ${SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES}`,
        retryable: false,
      },
    };
  }
  return { ok: true, value: sizeBytes };
}

export async function createNexusScratchpad(
  config: NexusScratchpadConfig,
): Promise<ScratchpadComponent> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;
  const groupId = config.groupId as string;
  const authorId = config.authorId as string;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Nexus is always the authority. We deliberately do NOT swap to a
  // fallback on a failed startup health probe: a generic probe failure
  // is not proof that Nexus has lost this group's scratchpad state.
  // Returning a local fallback in that window would let this instance
  // read/write only the local store while other participants continue
  // hitting Nexus, producing silent divergence and effective data loss
  // from the caller's perspective. Operators who want a no-Nexus
  // environment construct scratchpad-local directly.
  const client = createNexusScratchpadClient(config.transport, prefix);
  const tracker = createChangeTracker(groupId);

  const subscribers = new Set<ChangeHandler>();
  const state = {
    polling: false,
    timer: null as ReturnType<typeof setInterval> | null,
  };

  function stopPolling(): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  async function poll(): Promise<void> {
    if (state.polling) return;
    state.polling = true;
    try {
      // Walk pages until the server reports no continuation cursor. A
      // failing/misbehaving server is treated as a missed tick: we stop
      // diffing for delete synthesis this round and try again next
      // interval, rather than tearing down the storage authority.
      const accumulated: ScratchpadEntrySummary[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let pageCount = 0;
      do {
        if (pageCount >= MAX_PAGES_PER_DRAIN) return;
        if (cursor !== undefined && seenCursors.has(cursor)) return;
        if (cursor !== undefined) seenCursors.add(cursor);
        const listed = await client.list(groupId, undefined, pageSize, cursor);
        if (!listed.ok) return;
        const summaries = mapSummaries(listed.value);
        if (summaries.length === 0 && listed.value.nextCursor !== undefined) return;
        accumulated.push(...summaries);
        cursor = listed.value.nextCursor;
        pageCount += 1;
      } while (cursor !== undefined);

      // Successful drain: the server returned no continuation cursor on
      // the terminal page, so the snapshot is exhaustive. The previous
      // `lastPageSize < pageSize` heuristic silently suppressed delete
      // synthesis whenever the group size happened to be an exact
      // multiple of `pageSize` — a legitimate paginated server would
      // return an empty terminal page (or no `nextCursor`) and we would
      // never emit deletion events. Trusting the cursor contract
      // restores correctness; legacy servers that ignore `nextCursor`
      // entirely are out of scope (use scratchpad-local instead).
      for (const event of tracker.nextEvents(accumulated, { complete: true })) {
        for (const handler of subscribers) handler(event);
      }
    } finally {
      state.polling = false;
    }
  }

  function ensurePolling(): void {
    if (state.timer !== null || subscribers.size === 0) return;
    state.timer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
  }

  return {
    write: async (
      input: ScratchpadWriteInput,
    ): Promise<Result<ScratchpadWriteResult, KoiError>> => {
      const pathErr = validatePath(input.path);
      if (pathErr !== null) return { ok: false, error: pathErr };
      const ttlErr = validateTtl(input.ttlSeconds);
      if (ttlErr !== null) return { ok: false, error: ttlErr };
      let cloned: Record<string, unknown> | undefined;
      if (input.metadata !== undefined) {
        const metaResult = cloneMetadata(input.metadata);
        if (!metaResult.ok) return metaResult;
        cloned = metaResult.value;
      }
      const sizeResult = validateEntrySize(input.content, cloned);
      if (!sizeResult.ok) return sizeResult;
      const sanitized: ScratchpadWriteInput = {
        path: input.path,
        content: input.content,
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(cloned !== undefined ? { metadata: cloned } : {}),
        ...(input.expectedGeneration !== undefined
          ? { expectedGeneration: input.expectedGeneration }
          : {}),
      };
      const result = await client.write(groupId, authorId, sanitized);
      if (result.ok) {
        return {
          ok: true,
          value: {
            path: scratchpadPath(result.value.path),
            generation: result.value.generation,
            sizeBytes: result.value.sizeBytes,
          },
        };
      }
      return result;
    },
    read: async (path: ScratchpadPath) => {
      const pathErr = validatePath(path);
      if (pathErr !== null) return { ok: false, error: pathErr };
      const result = await client.read(groupId, path as string);
      if (result.ok) return { ok: true, value: mapEntry(result.value.entry) };
      return result;
    },
    list: async (filter?: ScratchpadFilter) => {
      // Drain nextCursor pages so callers always see a complete snapshot.
      // `ScratchpadComponent.list` exposes no pagination surface, so partial
      // results would silently truncate user data. If the caller passes an
      // explicit `filter.limit` we honor that as a hard cap on the merged
      // result, since it is the user's stated preference.
      const limit = filter?.limit ?? pageSize;
      const accumulated: ScratchpadEntrySummary[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let pageCount = 0;
      do {
        if (pageCount >= MAX_PAGES_PER_DRAIN) {
          throw new Error(
            `Nexus scratchpad list exceeded ${MAX_PAGES_PER_DRAIN} pages without exhausting the cursor`,
          );
        }
        if (cursor !== undefined && seenCursors.has(cursor)) {
          throw new Error("Nexus scratchpad list returned a repeating pagination cursor");
        }
        if (cursor !== undefined) seenCursors.add(cursor);
        const result = await client.list(groupId, filter, limit, cursor);
        if (!result.ok) {
          // Surface the transport failure. Returning `[]` (or substituting
          // an unrelated fallback) would collapse a Nexus outage into a
          // legitimate empty state and let callers perform destructive
          // cleanup based on a false absence.
          throw new Error("Nexus scratchpad list failed", { cause: result.error });
        }
        const summaries = mapSummaries(result.value);
        if (summaries.length === 0 && result.value.nextCursor !== undefined) {
          throw new Error(
            "Nexus scratchpad list returned an empty page with a continuation cursor",
          );
        }
        accumulated.push(...summaries);
        cursor = result.value.nextCursor;
        pageCount += 1;
        if (filter?.limit !== undefined && accumulated.length >= filter.limit) {
          return accumulated.slice(0, filter.limit);
        }
      } while (cursor !== undefined);
      return accumulated;
    },
    delete: async (path: ScratchpadPath) => {
      const pathErr = validatePath(path);
      if (pathErr !== null) return { ok: false, error: pathErr };
      const result = await client.delete(groupId, authorId, path as string);
      return result;
    },
    flush: async () => {
      tracker.clear();
    },
    onChange: (handler) => {
      subscribers.add(handler);
      ensurePolling();
      void poll();
      return () => {
        subscribers.delete(handler);
        if (subscribers.size === 0) stopPolling();
      };
    },
  };
}
