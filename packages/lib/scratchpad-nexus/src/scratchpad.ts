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
import { scratchpadPath } from "@koi/core";
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

export async function createNexusScratchpad(
  config: NexusScratchpadConfig,
): Promise<ScratchpadComponent> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;
  const groupId = config.groupId as string;
  const authorId = config.authorId as string;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const serverSupportsPagination = config.serverSupportsPagination ?? false;

  // The up-front health probe is the ONLY failover boundary. Once we have
  // returned the Nexus-routed component below, runtime RPC failures must
  // NEVER swap the storage authority to the unrelated fallback: the two
  // backends do not share state, so silently rerouting reads/writes after
  // a transient blip would fork the source of truth — Nexus would still
  // hold the real entries while callers see (and overwrite) an empty
  // local store. Errors propagate to callers instead.
  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) return config.fallback;
  }

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
      let lastPageSize = 0;
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
        lastPageSize = summaries.length;
        pageCount += 1;
      } while (cursor !== undefined);

      // Treat the snapshot as exhaustive only when we either (a) have an
      // explicit capability declaration that the server honors `nextCursor`,
      // or (b) the terminal page came back below `pageSize` so it cannot
      // possibly be hiding more entries on a later page. Default-off, so
      // legacy servers don't trigger spurious deletion events.
      const complete = serverSupportsPagination || lastPageSize < pageSize;
      for (const event of tracker.nextEvents(accumulated, { complete })) {
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
      const result = await client.write(groupId, authorId, input);
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
