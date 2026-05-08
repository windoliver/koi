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
  const serverSupportsPagination = config.serverSupportsPagination ?? true;

  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) return config.fallback;
  }

  const client = createNexusScratchpadClient(config.transport, prefix);
  const tracker = createChangeTracker(groupId);

  // For each registered handler we track its current unsubscribe function. Pre-
  // degrade it removes the handler from the local poll set; post-degrade it is
  // replaced with the unsubscribe returned by `fallback.onChange()` so existing
  // user-returned unsubscribers stay correct across the degrade boundary.
  const subscriptions = new Map<ChangeHandler, () => void>();
  const subscribers = new Set<ChangeHandler>();

  const state = {
    closed: false,
    degraded: false,
    polling: false,
    timer: null as ReturnType<typeof setInterval> | null,
  };

  function stopPolling(): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function degradeToFallback(): void {
    if (state.degraded) return;
    state.degraded = true;
    stopPolling();
    if (config.fallback === undefined) {
      // No fallback to hand off to. Mark the component closed so subscribers
      // can be cleaned up; without a fallback there is nowhere left to deliver
      // events from. Caller-provided handlers stay registered until they
      // unsubscribe, but the polling timer is stopped so we do not silently
      // hammer a broken server forever.
      state.closed = true;
      return;
    }
    // Hand active subscribers off to the fallback so existing change streams
    // keep delivering events instead of silently going dark on degrade.
    const fallback = config.fallback;
    for (const handler of subscribers) {
      const unsubscribe = fallback.onChange(handler);
      subscriptions.set(handler, unsubscribe);
    }
    subscribers.clear();
  }

  async function poll(): Promise<void> {
    if (state.closed || state.degraded || state.polling) return;
    state.polling = true;
    try {
      // Walk pages until the server reports no continuation cursor. Per the
      // `NexusScratchpadListResponse` contract, an absent `nextCursor` means the
      // snapshot is exhaustive — even when a page lands on exactly `pageSize`.
      // Once the loop drains, the accumulated snapshot is complete and safe to
      // diff for delete synthesis.
      const accumulated: ScratchpadEntrySummary[] = [];
      let cursor: string | undefined;
      let lastPageSize = 0;
      const seenCursors = new Set<string>();
      let pageCount = 0;
      do {
        if (pageCount >= MAX_PAGES_PER_DRAIN) {
          // Server is handing out more pages than we will ever accept. Treat
          // this as a transport failure so we degrade cleanly instead of
          // wedging the poller.
          degradeToFallback();
          return;
        }
        if (cursor !== undefined && seenCursors.has(cursor)) {
          // Repeated cursor — server is not advancing. Bail to avoid an
          // infinite loop.
          degradeToFallback();
          return;
        }
        if (cursor !== undefined) seenCursors.add(cursor);
        const listed = await client.list(groupId, undefined, pageSize, cursor);
        if (!listed.ok) {
          degradeToFallback();
          return;
        }
        const summaries = mapSummaries(listed.value);
        if (summaries.length === 0 && listed.value.nextCursor !== undefined) {
          // Zero-progress page with another cursor — guard against an empty
          // pagination loop.
          degradeToFallback();
          return;
        }
        accumulated.push(...summaries);
        cursor = listed.value.nextCursor;
        lastPageSize = summaries.length;
        pageCount += 1;
      } while (cursor !== undefined);

      // Treat the snapshot as exhaustive only when we either (a) have an
      // explicit capability declaration that the server honors `nextCursor`,
      // or (b) the terminal page came back below `pageSize` so it cannot
      // possibly be hiding more entries on a later page. This is the safe
      // default for older Nexus servers that ignore the cursor field — we
      // skip delete synthesis rather than risk announcing false deletions
      // for paths that simply live beyond the first page.
      const complete = serverSupportsPagination || lastPageSize < pageSize;
      for (const event of tracker.nextEvents(accumulated, { complete })) {
        for (const handler of subscribers) handler(event);
      }
    } finally {
      state.polling = false;
    }
  }

  function ensurePolling(): void {
    if (state.closed || state.degraded || state.timer !== null || subscribers.size === 0) return;
    state.timer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
  }

  return {
    write: async (
      input: ScratchpadWriteInput,
    ): Promise<Result<ScratchpadWriteResult, KoiError>> => {
      if (state.degraded && config.fallback !== undefined) {
        return await config.fallback.write(input);
      }

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
      if (config.fallback !== undefined) {
        degradeToFallback();
        return await config.fallback.write(input);
      }
      return result;
    },
    read: async (path: ScratchpadPath) => {
      if (state.degraded && config.fallback !== undefined) {
        return await config.fallback.read(path);
      }

      const result = await client.read(groupId, path as string);
      if (result.ok) {
        return { ok: true, value: mapEntry(result.value.entry) };
      }
      if (config.fallback !== undefined) {
        degradeToFallback();
        return await config.fallback.read(path);
      }
      return result;
    },
    list: async (filter?: ScratchpadFilter) => {
      if (state.degraded && config.fallback !== undefined) {
        return await config.fallback.list(filter);
      }

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
          if (config.fallback !== undefined) {
            degradeToFallback();
            return await config.fallback.list(filter);
          }
          return [];
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
      if (state.degraded && config.fallback !== undefined) {
        return await config.fallback.delete(path);
      }

      const result = await client.delete(groupId, authorId, path as string);
      if (result.ok) return result;
      if (config.fallback !== undefined) {
        degradeToFallback();
        return await config.fallback.delete(path);
      }
      return result;
    },
    flush: async () => {
      if (state.degraded && config.fallback !== undefined) {
        await config.fallback.flush();
        return;
      }
      tracker.clear();
    },
    onChange: (handler) => {
      if (state.degraded && config.fallback !== undefined) {
        const unsubscribe = config.fallback.onChange(handler);
        subscriptions.set(handler, unsubscribe);
        return () => {
          subscriptions.get(handler)?.();
          subscriptions.delete(handler);
        };
      }

      subscribers.add(handler);
      const localUnsubscribe = (): void => {
        subscribers.delete(handler);
        if (subscribers.size === 0) {
          stopPolling();
        }
      };
      subscriptions.set(handler, localUnsubscribe);
      ensurePolling();
      void poll();

      return () => {
        // Resolve at call time: if degrade happened in between, this calls the
        // fallback's unsubscribe; otherwise it removes from the local set.
        subscriptions.get(handler)?.();
        subscriptions.delete(handler);
      };
    },
  };
}
