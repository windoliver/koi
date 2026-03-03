/**
 * Nexus-backed EventBackend implementation.
 *
 * Stores events on a Nexus filesystem via JSON-RPC 2.0. Each event is a
 * separate file, enabling atomic writes without file-level locking.
 * meta.json per stream tracks maxSequence + eventCount for O(1) sequence lookups.
 *
 * Path convention:
 *   /events/streams/{streamId}/meta.json
 *   /events/streams/{streamId}/events/0000000001.json
 *   /events/subscriptions/{subscriptionName}.json
 *   /events/dead-letters/{entryId}.json
 */

import type {
  DeadLetterEntry,
  DeadLetterFilter,
  EventBackend,
  EventBackendConfig,
  EventEnvelope,
  EventInput,
  KoiError,
  ReadOptions,
  ReadResult,
  Result,
  SubscribeOptions,
  SubscriptionHandle,
} from "@koi/core";
import { conflict, internal, validation } from "@koi/core";
import { createDeliveryManager } from "@koi/event-delivery";
import { generateUlid } from "@koi/hash";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { validatePathSegment } from "./shared/nexus-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusEventBackendConfig extends EventBackendConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Storage path prefix. Default: "/events". */
  readonly basePath?: string | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Stream metadata — persisted as meta.json per stream
// ---------------------------------------------------------------------------

interface StreamMeta {
  readonly maxSequence: number;
  readonly eventCount: number;
}

const EMPTY_META: StreamMeta = { maxSequence: 0, eventCount: 0 };

// ---------------------------------------------------------------------------
// Path helpers — zero-padded sequences for lexicographic ordering
// ---------------------------------------------------------------------------

const SEQUENCE_DIGITS = 10;
const DEFAULT_MAX_EVENTS_PER_STREAM = 10_000;

function formatSequence(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_DIGITS, "0");
}

function streamMetaPath(basePath: string, streamId: string): string {
  return `${basePath}/streams/${streamId}/meta.json`;
}

function eventFilePath(basePath: string, streamId: string, sequence: number): string {
  return `${basePath}/streams/${streamId}/events/${formatSequence(sequence)}.json`;
}

function subscriptionFilePath(basePath: string, subscriptionName: string): string {
  return `${basePath}/subscriptions/${subscriptionName}.json`;
}

function deadLetterFilePath(basePath: string, entryId: string): string {
  return `${basePath}/dead-letters/${entryId}.json`;
}

function deadLetterGlobPattern(basePath: string): string {
  return `${basePath}/dead-letters/*.json`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Nexus-backed EventBackend.
 *
 * Events are stored on a Nexus filesystem as individual JSON files.
 * FIFO eviction keeps each stream under `maxEventsPerStream`.
 * TTL eviction excludes expired events from reads.
 */
export function createNexusEventBackend(config: NexusEventBackendConfig): EventBackend {
  const maxPerStream = config.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
  const eventTtlMs = config.eventTtlMs;
  const basePath = config.basePath ?? "/events";
  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  // -------------------------------------------------------------------------
  // Nexus I/O helpers
  // -------------------------------------------------------------------------

  async function readMeta(streamId: string): Promise<Result<StreamMeta, KoiError>> {
    const result = await client.rpc<string>("read", { path: streamMetaPath(basePath, streamId) });
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND" || result.error.code === "EXTERNAL") {
        return { ok: true, value: EMPTY_META };
      }
      return result;
    }
    try {
      return { ok: true, value: JSON.parse(result.value) as StreamMeta };
    } catch {
      return { ok: true, value: EMPTY_META };
    }
  }

  async function writeMeta(streamId: string, meta: StreamMeta): Promise<Result<void, KoiError>> {
    return client.rpc<void>("write", {
      path: streamMetaPath(basePath, streamId),
      content: JSON.stringify(meta),
    });
  }

  async function writeEvent(
    streamId: string,
    sequence: number,
    envelope: EventEnvelope,
  ): Promise<Result<void, KoiError>> {
    return client.rpc<void>("write", {
      path: eventFilePath(basePath, streamId, sequence),
      content: JSON.stringify(envelope),
    });
  }

  async function readEvent(
    streamId: string,
    sequence: number,
  ): Promise<Result<EventEnvelope, KoiError>> {
    const result = await client.rpc<string>("read", {
      path: eventFilePath(basePath, streamId, sequence),
    });
    if (!result.ok) return result;
    try {
      return { ok: true, value: JSON.parse(result.value) as EventEnvelope };
    } catch {
      return {
        ok: false,
        error: internal(`Corrupt event data at seq ${String(sequence)} in stream ${streamId}`),
      };
    }
  }

  function isExpired(event: EventEnvelope, now: number): boolean {
    if (eventTtlMs === undefined) return false;
    return now - event.timestamp > eventTtlMs;
  }

  // -------------------------------------------------------------------------
  // Deferred eviction — amortized O(1) per append
  // -------------------------------------------------------------------------

  const EVICTION_INTERVAL = 100;
  const EVICTION_DEBT_THRESHOLD = Math.max(1, Math.floor(maxPerStream / 10));

  // Map — internal mutable counter for tracking pending eviction debt per stream
  const evictionDebt = new Map<string, number>();

  function shouldEvict(streamId: string): boolean {
    const debt = evictionDebt.get(streamId) ?? 0;
    return debt >= EVICTION_INTERVAL || debt >= EVICTION_DEBT_THRESHOLD;
  }

  function incrementDebt(streamId: string): void {
    evictionDebt.set(streamId, (evictionDebt.get(streamId) ?? 0) + 1);
  }

  function resetDebt(streamId: string): void {
    evictionDebt.delete(streamId);
  }

  async function evictNow(
    streamId: string,
    meta: StreamMeta,
  ): Promise<Result<StreamMeta, KoiError>> {
    // let justified: meta mutates through TTL and FIFO eviction passes
    let currentMeta = meta;

    // TTL eviction — remove expired events from the front
    if (eventTtlMs !== undefined) {
      const now = Date.now();
      const startSeq = currentMeta.maxSequence - currentMeta.eventCount + 1;
      // let justified: scanning forward for first non-expired index
      let evicted = 0;
      for (let seq = startSeq; seq <= currentMeta.maxSequence; seq++) {
        const evtResult = await readEvent(streamId, seq);
        if (!evtResult.ok) break;
        if (!isExpired(evtResult.value, now)) break;
        await client.rpc<void>("delete", {
          path: eventFilePath(basePath, streamId, seq),
        });
        evicted++;
      }
      if (evicted > 0) {
        currentMeta = {
          maxSequence: currentMeta.maxSequence,
          eventCount: currentMeta.eventCount - evicted,
        };
      }
    }

    // FIFO eviction — cap stream length
    const excess = currentMeta.eventCount - maxPerStream;
    if (excess > 0) {
      const startSeq = currentMeta.maxSequence - currentMeta.eventCount + 1;
      for (let i = 0; i < excess; i++) {
        await client.rpc<void>("delete", {
          path: eventFilePath(basePath, streamId, startSeq + i),
        });
      }
      currentMeta = {
        maxSequence: currentMeta.maxSequence,
        eventCount: currentMeta.eventCount - excess,
      };
    }

    // Persist updated meta and reset debt
    if (currentMeta !== meta) {
      const writeResult = await writeMeta(streamId, currentMeta);
      if (!writeResult.ok) return writeResult;
    }
    resetDebt(streamId);

    return { ok: true, value: currentMeta };
  }

  // -------------------------------------------------------------------------
  // Delivery manager — delegates persistence to Nexus
  // -------------------------------------------------------------------------

  const delivery = createDeliveryManager({
    persistPosition: async (subscriptionName, sequence) => {
      await client.rpc<void>("write", {
        path: subscriptionFilePath(basePath, subscriptionName),
        content: JSON.stringify({ position: sequence }),
      });
    },
    persistDeadLetter: async (entry) => {
      await client.rpc<void>("write", {
        path: deadLetterFilePath(basePath, entry.id),
        content: JSON.stringify(entry),
      });
    },
    readStream: async (streamId, fromSequence) => {
      const metaResult = await readMeta(streamId);
      if (!metaResult.ok) return [];
      const meta = metaResult.value;
      if (meta.eventCount === 0) return [];

      const startSeq = Math.max(fromSequence + 1, meta.maxSequence - meta.eventCount + 1);
      const events: EventEnvelope[] = [];
      for (let seq = startSeq; seq <= meta.maxSequence; seq++) {
        const evtResult = await readEvent(streamId, seq);
        if (evtResult.ok) {
          events.push(evtResult.value);
        }
      }
      return events;
    },
    removeDeadLetter: async (entryId) => {
      const result = await client.rpc<void>("delete", {
        path: deadLetterFilePath(basePath, entryId),
      });
      return result.ok;
    },
  });

  // -------------------------------------------------------------------------
  // EventBackend implementation
  // -------------------------------------------------------------------------

  const append = async (
    streamId: string,
    event: EventInput,
  ): Promise<Result<EventEnvelope, KoiError>> => {
    const segCheck = validatePathSegment(streamId, "Stream ID");
    if (!segCheck.ok) return segCheck;
    if (event.type === "") {
      return { ok: false, error: validation("event type must not be empty") };
    }

    try {
      const metaResult = await readMeta(streamId);
      if (!metaResult.ok) return metaResult;
      const meta = metaResult.value;

      // Optimistic concurrency check
      if (event.expectedSequence !== undefined) {
        if (meta.maxSequence !== event.expectedSequence) {
          return {
            ok: false,
            error: conflict(
              streamId,
              `Stream "${streamId}" sequence mismatch: expected ${String(event.expectedSequence)}, current is ${String(meta.maxSequence)}`,
            ),
          };
        }
      }

      const seq = meta.maxSequence + 1;
      const envelope: EventEnvelope = {
        id: generateUlid(),
        streamId,
        type: event.type,
        timestamp: Date.now(),
        sequence: seq,
        data: event.data,
        metadata: event.metadata,
      };

      // Write event file
      const writeResult = await writeEvent(streamId, seq, envelope);
      if (!writeResult.ok) return writeResult;

      // Update meta
      const newMeta: StreamMeta = {
        maxSequence: seq,
        eventCount: meta.eventCount + 1,
      };
      const metaWriteResult = await writeMeta(streamId, newMeta);
      if (!metaWriteResult.ok) return metaWriteResult;

      // Deferred eviction — amortize cost across multiple appends
      incrementDebt(streamId);
      if (shouldEvict(streamId)) {
        await evictNow(streamId, newMeta);
      }

      // Notify subscribers
      delivery.notifySubscribers(streamId, envelope);

      return { ok: true, value: envelope };
    } catch (err: unknown) {
      return { ok: false, error: internal("Failed to append event", err) };
    }
  };

  const read = async (
    streamId: string,
    options?: ReadOptions,
  ): Promise<Result<ReadResult, KoiError>> => {
    const segCheck = validatePathSegment(streamId, "Stream ID");
    if (!segCheck.ok) return segCheck;
    try {
      const metaResult = await readMeta(streamId);
      if (!metaResult.ok) return metaResult;
      const meta = metaResult.value;

      if (meta.eventCount === 0) {
        return { ok: true, value: { events: [], hasMore: false } };
      }

      const from = options?.fromSequence ?? 1;
      const to = options?.toSequence ?? Number.MAX_SAFE_INTEGER;
      const direction = options?.direction ?? "forward";
      const limit = options?.limit;
      const typeFilter = options?.types !== undefined ? new Set(options.types) : undefined;
      const now = Date.now();

      // Compute actual range within stream bounds
      const streamStart = meta.maxSequence - meta.eventCount + 1;
      const rangeStart = Math.max(from, streamStart);
      const rangeEnd = Math.min(to, meta.maxSequence + 1); // exclusive

      // Read events in range
      const events: EventEnvelope[] = [];
      for (let seq = rangeStart; seq < rangeEnd; seq++) {
        const evtResult = await readEvent(streamId, seq);
        if (!evtResult.ok) continue;
        const evt = evtResult.value;

        // TTL filter
        if (isExpired(evt, now)) continue;

        // Type filter
        if (typeFilter !== undefined && !typeFilter.has(evt.type)) continue;

        events.push(evt);
      }

      const ordered = direction === "backward" ? events.toReversed() : events;

      if (limit !== undefined && limit < ordered.length) {
        return {
          ok: true,
          value: { events: ordered.slice(0, limit), hasMore: true },
        };
      }

      return { ok: true, value: { events: ordered, hasMore: false } };
    } catch (err: unknown) {
      return { ok: false, error: internal("Failed to read events", err) };
    }
  };

  const subscribe = (options: SubscribeOptions): SubscriptionHandle => {
    return delivery.subscribe(options);
  };

  const queryDeadLetters = (
    filter?: DeadLetterFilter,
  ):
    | Result<readonly DeadLetterEntry[], KoiError>
    | Promise<Result<readonly DeadLetterEntry[], KoiError>> => {
    return delivery.queryDeadLetters(filter);
  };

  const retryDeadLetter = (
    entryId: string,
  ): Result<boolean, KoiError> | Promise<Result<boolean, KoiError>> => {
    return delivery.retryDeadLetter(entryId);
  };

  const purgeDeadLetters = (
    filter?: DeadLetterFilter,
  ): Result<void, KoiError> | Promise<Result<void, KoiError>> => {
    const result = delivery.purgeDeadLetters(filter);

    // Also clean up Nexus DLQ files in the background
    void (async () => {
      try {
        const globResult = await client.rpc<readonly string[]>("glob", {
          pattern: deadLetterGlobPattern(basePath),
        });
        if (!globResult.ok) return;

        if (filter === undefined) {
          await Promise.all(
            globResult.value.map((filePath) => client.rpc<void>("delete", { path: filePath })),
          );
        } else {
          for (const filePath of globResult.value) {
            const readResult = await client.rpc<string>("read", { path: filePath });
            if (!readResult.ok) continue;
            try {
              const entry = JSON.parse(readResult.value) as DeadLetterEntry;
              const matchStream =
                filter.streamId === undefined || entry.event.streamId === filter.streamId;
              const matchSub =
                filter.subscriptionName === undefined ||
                entry.subscriptionName === filter.subscriptionName;
              if (matchStream && matchSub) {
                await client.rpc<void>("delete", { path: filePath });
              }
            } catch {
              // Skip corrupt files
            }
          }
        }
      } catch {
        // Best-effort cleanup
      }
    })();

    return result;
  };

  const streamLength = async (streamId: string): Promise<number> => {
    const metaResult = await readMeta(streamId);
    if (!metaResult.ok) return 0;
    const meta = metaResult.value;

    if (eventTtlMs === undefined) return meta.eventCount;

    // With TTL, count non-expired events
    const now = Date.now();
    const startSeq = meta.maxSequence - meta.eventCount + 1;
    // let justified: counting non-expired events
    let count = 0;
    for (let seq = startSeq; seq <= meta.maxSequence; seq++) {
      const evtResult = await readEvent(streamId, seq);
      if (!evtResult.ok) continue;
      if (!isExpired(evtResult.value, now)) count++;
    }
    return count;
  };

  const firstSequence = async (streamId: string): Promise<number> => {
    const metaResult = await readMeta(streamId);
    if (!metaResult.ok) return 0;
    const meta = metaResult.value;
    if (meta.eventCount === 0) return 0;

    const startSeq = meta.maxSequence - meta.eventCount + 1;

    if (eventTtlMs === undefined) return startSeq;

    // With TTL, find first non-expired event
    const now = Date.now();
    for (let seq = startSeq; seq <= meta.maxSequence; seq++) {
      const evtResult = await readEvent(streamId, seq);
      if (!evtResult.ok) continue;
      if (!isExpired(evtResult.value, now)) return evtResult.value.sequence;
    }
    return 0;
  };

  const close = (): void => {
    delivery.closeAll();
  };

  return {
    append,
    read,
    subscribe,
    queryDeadLetters,
    retryDeadLetter,
    purgeDeadLetters,
    streamLength,
    firstSequence,
    close,
  };
}
