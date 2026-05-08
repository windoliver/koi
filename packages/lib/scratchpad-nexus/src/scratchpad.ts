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
import { scratchpadPath } from "@koi/core";
import { type ChangeTracker, createChangeTracker } from "./change-tracker.js";
import { createNexusScratchpadClient, type NexusScratchpadClient } from "./client.js";
import { mapEntry, mapSummaries } from "./map-entry.js";
import type { NexusScratchpadConfig } from "./types.js";
import { cloneMetadata, validateEntrySize, validatePath, validateTtl } from "./validation.js";

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

async function nexusWrite(
  client: NexusScratchpadClient,
  groupId: string,
  authorId: string,
  input: ScratchpadWriteInput,
): Promise<Result<ScratchpadWriteResult, KoiError>> {
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
}

async function nexusRead(
  client: NexusScratchpadClient,
  groupId: string,
  path: ScratchpadPath,
): Promise<Result<ScratchpadEntry, KoiError>> {
  const pathErr = validatePath(path);
  if (pathErr !== null) return { ok: false, error: pathErr };
  const result = await client.read(groupId, path as string);
  if (result.ok) return { ok: true, value: mapEntry(result.value.entry) };
  return result;
}

async function nexusList(
  client: NexusScratchpadClient,
  groupId: string,
  pageSize: number,
  filter: ScratchpadFilter | undefined,
): Promise<readonly ScratchpadEntrySummary[]> {
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
      throw new Error("Nexus scratchpad list failed", { cause: result.error });
    }
    const summaries = mapSummaries(result.value);
    if (summaries.length === 0 && result.value.nextCursor !== undefined) {
      throw new Error("Nexus scratchpad list returned an empty page with a continuation cursor");
    }
    accumulated.push(...summaries);
    cursor = result.value.nextCursor;
    pageCount += 1;
    if (filter?.limit !== undefined && accumulated.length >= filter.limit) {
      return accumulated.slice(0, filter.limit);
    }
  } while (cursor !== undefined);
  return accumulated;
}

async function nexusDelete(
  client: NexusScratchpadClient,
  groupId: string,
  authorId: string,
  path: ScratchpadPath,
): Promise<Result<void, KoiError>> {
  const pathErr = validatePath(path);
  if (pathErr !== null) return { ok: false, error: pathErr };
  return client.delete(groupId, authorId, path as string);
}

/**
 * Drain all pages from a list call into a flat snapshot. Returns `null` when
 * the server misbehaves (failure, repeating cursor, exceeded page cap, empty
 * page with a continuation cursor) — caller treats that as a missed tick.
 */
async function drainSnapshot(
  client: NexusScratchpadClient,
  groupId: string,
  pageSize: number,
): Promise<readonly ScratchpadEntrySummary[] | null> {
  const accumulated: ScratchpadEntrySummary[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let pageCount = 0;
  do {
    if (pageCount >= MAX_PAGES_PER_DRAIN) return null;
    if (cursor !== undefined && seenCursors.has(cursor)) return null;
    if (cursor !== undefined) seenCursors.add(cursor);
    const listed = await client.list(groupId, undefined, pageSize, cursor);
    if (!listed.ok) return null;
    const summaries = mapSummaries(listed.value);
    if (summaries.length === 0 && listed.value.nextCursor !== undefined) return null;
    accumulated.push(...summaries);
    cursor = listed.value.nextCursor;
    pageCount += 1;
  } while (cursor !== undefined);
  return accumulated;
}

function deliverEvents(
  events: readonly ScratchpadChangeEvent[],
  subscribers: ReadonlySet<ChangeHandler>,
): void {
  for (const event of events) {
    // Isolate each subscriber: a throwing handler must NOT abort delivery
    // to the others or drop events for the next round. Matches
    // scratchpad-local's observer-exception swallowing.
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch {
        // Subscriber failure must not affect peers or future delivery.
      }
    }
  }
}

/**
 * Startup-only escape hatch: when the operator wires a local fallback and
 * the initial health probe fails, hand the caller the raw fallback as the
 * sole authority for the lifetime of this instance. Runtime RPC failures
 * must NEVER swap authorities, since the two backends do not share state —
 * silently rerouting reads/writes would fork the source of truth and produce
 * effective data loss for the caller.
 */
async function resolveFallback(config: NexusScratchpadConfig): Promise<ScratchpadComponent | null> {
  if (config.fallback === undefined || config.transport.health === undefined) return null;
  const health = await config.transport.health();
  return health.ok ? null : config.fallback;
}

function makeOnChange(
  subscribers: Set<ChangeHandler>,
  tracker: ChangeTracker,
  controller: PollController,
): ScratchpadComponent["onChange"] {
  return (handler) => {
    // When transitioning from 0 → 1 subscribers, reset the tracker so the
    // new watcher establishes a fresh baseline from the next poll and never
    // receives changes that happened during the unsubscribed gap.
    if (subscribers.size === 0) tracker.clear();
    subscribers.add(handler);
    controller.ensurePolling();
    void controller.poll();
    return () => {
      subscribers.delete(handler);
      if (subscribers.size === 0) controller.stopPolling();
    };
  };
}

interface PollController {
  readonly poll: () => Promise<void>;
  readonly ensurePolling: () => void;
  readonly stopPolling: () => void;
}

function createPollController(
  client: NexusScratchpadClient,
  tracker: ChangeTracker,
  subscribers: ReadonlySet<ChangeHandler>,
  groupId: string,
  pageSize: number,
  pollIntervalMs: number,
): PollController {
  const state = { polling: false, timer: null as ReturnType<typeof setInterval> | null };

  const poll = async (): Promise<void> => {
    if (state.polling) return;
    state.polling = true;
    try {
      // Walk pages until the server reports no continuation cursor. A
      // failing/misbehaving server is treated as a missed tick: we stop
      // diffing for delete synthesis this round and try again next interval,
      // rather than tearing down the storage authority.
      const snapshot = await drainSnapshot(client, groupId, pageSize);
      if (snapshot === null) return;
      // Successful drain: trust the server's cursor contract and emit deltas.
      // The previous `lastPageSize < pageSize` heuristic silently suppressed
      // delete synthesis whenever the group size happened to be an exact
      // multiple of `pageSize`.
      deliverEvents(tracker.nextEvents(snapshot, { complete: true }), subscribers);
    } finally {
      state.polling = false;
    }
  };

  return {
    poll,
    ensurePolling: () => {
      if (state.timer !== null || subscribers.size === 0) return;
      state.timer = setInterval(() => {
        void poll();
      }, pollIntervalMs);
    },
    stopPolling: () => {
      if (state.timer !== null) {
        clearInterval(state.timer);
        state.timer = null;
      }
    },
  };
}

export async function createNexusScratchpad(
  config: NexusScratchpadConfig,
): Promise<ScratchpadComponent> {
  const fallback = await resolveFallback(config);
  if (fallback !== null) return fallback;

  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;
  const groupId = config.groupId as string;
  const authorId = config.authorId as string;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const client = createNexusScratchpadClient(config.transport, prefix);
  const tracker = createChangeTracker(groupId);
  const subscribers = new Set<ChangeHandler>();
  const controller = createPollController(
    client,
    tracker,
    subscribers,
    groupId,
    pageSize,
    pollIntervalMs,
  );

  return {
    write: (input) => nexusWrite(client, groupId, authorId, input),
    read: (path) => nexusRead(client, groupId, path),
    list: (filter) => nexusList(client, groupId, pageSize, filter),
    delete: (path) => nexusDelete(client, groupId, authorId, path),
    flush: async () => {
      // No pending writes to commit — every write is an immediate RPC.
      // Must NOT reset the change tracker here: a caller that writes then
      // calls flush() is not asking to wipe its event baseline, and doing so
      // silently suppresses the next poll's deltas. Matches scratchpad-local.
    },
    onChange: makeOnChange(subscribers, tracker, controller),
  };
}

// Re-export for type consumers that previously relied on it
export type { ChangeTracker };
