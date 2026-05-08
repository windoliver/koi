import type {
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadComponent,
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

export async function createNexusScratchpad(
  config: NexusScratchpadConfig,
): Promise<ScratchpadComponent> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;
  const groupId = config.groupId as string;
  const authorId = config.authorId as string;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) return config.fallback;
  }

  const client = createNexusScratchpadClient(config.transport, prefix);
  const tracker = createChangeTracker(groupId);
  const subscribers = new Set<(event: ScratchpadChangeEvent) => void>();

  const state = {
    closed: false,
    degraded: false,
    timer: null as ReturnType<typeof setInterval> | null,
  };

  function stopPolling(): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function degradeToFallback(): void {
    if (config.fallback === undefined) return;
    state.degraded = true;
    stopPolling();
  }

  async function poll(): Promise<void> {
    if (state.closed || state.degraded) return;

    const listed = await client.list(groupId, undefined, pageSize);
    if (!listed.ok) {
      degradeToFallback();
      return;
    }

    for (const event of tracker.nextEvents(mapSummaries(listed.value))) {
      for (const handler of subscribers) handler(event);
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

      const result = await client.list(groupId, filter, filter?.limit ?? pageSize);
      if (!result.ok) {
        if (config.fallback !== undefined) {
          degradeToFallback();
          return await config.fallback.list(filter);
        }
        return [];
      }
      return mapSummaries(result.value);
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
        return config.fallback.onChange(handler);
      }

      subscribers.add(handler);
      ensurePolling();
      void poll();

      return () => {
        subscribers.delete(handler);
        if (subscribers.size === 0) {
          stopPolling();
        }
      };
    },
  };
}
