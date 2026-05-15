import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import {
  advanceCursor,
  createNexusSyncClient,
  deduplicateEvents,
  isFederationSyncEvent,
} from "./sync-protocol.js";
import type { FederationSyncEvent, SyncCursor } from "./types.js";

const ZB = zoneId("zone-b");

function evt(seq: number, kind: string = "test"): FederationSyncEvent {
  return {
    kind,
    originZoneId: ZB,
    sequence: seq,
    data: { n: seq },
    emittedAt: 1_000 + seq,
  };
}

const baseCursor: SyncCursor = { zoneId: ZB, lastSequence: 0, lastSyncAt: 0 };

describe("advanceCursor", () => {
  test("returns cursor with refreshed lastSyncAt when events empty", () => {
    const result = advanceCursor(baseCursor, [], 12_345);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lastSequence).toBe(0);
      expect(result.value.lastSyncAt).toBe(12_345);
      expect(result.value.zoneId).toBe(ZB);
    }
  });

  test("advances through ascending contiguous batch", () => {
    const result = advanceCursor(baseCursor, [evt(1), evt(2), evt(3)], 999);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lastSequence).toBe(3);
      expect(result.value.lastSyncAt).toBe(999);
    }
  });

  test("rejects reordered batches as a v1 protocol fault", () => {
    // Regression for #1372 review-loop pass-3 round 2: [2,1] is a
    // wire-contract violation. The exported helper must NOT silently
    // acknowledge it — that lets a buggy or compromised peer hide
    // events behind reordered batches.
    const result = advanceCursor(baseCursor, [evt(2), evt(1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toMatch(/expected sequence 1, saw 2/);
    }
  });

  test("rejects gapped batches and does not advance", () => {
    // Regression: [1,2,4,5] (missing 3) is a fault under v1.
    const result = advanceCursor(baseCursor, [evt(1), evt(2), evt(4), evt(5)]);
    expect(result.ok).toBe(false);
  });

  test("rejects an out-of-order [5] when cursor is 0", () => {
    const result = advanceCursor(baseCursor, [evt(5)]);
    expect(result.ok).toBe(false);
  });

  test("silently drops already-acknowledged duplicates and advances", () => {
    const cursor: SyncCursor = { zoneId: ZB, lastSequence: 2, lastSyncAt: 0 };
    const result = advanceCursor(cursor, [evt(1), evt(2), evt(3), evt(4)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lastSequence).toBe(4);
  });
});

describe("deduplicateEvents", () => {
  test("filters events with seq <= cursor.lastSequence", () => {
    const cursor: SyncCursor = { zoneId: ZB, lastSequence: 5, lastSyncAt: 0 };
    const out = deduplicateEvents([evt(3), evt(5), evt(6), evt(7)], cursor);
    expect(out.map((e) => e.sequence)).toEqual([6, 7]);
  });

  test("returns all events when cursor at zero", () => {
    const out = deduplicateEvents([evt(1), evt(2)], baseCursor);
    expect(out).toHaveLength(2);
  });

  test("returns empty when no new events", () => {
    const cursor: SyncCursor = { zoneId: ZB, lastSequence: 100, lastSyncAt: 0 };
    const out = deduplicateEvents([evt(1), evt(50)], cursor);
    expect(out).toEqual([]);
  });
});

describe("isFederationSyncEvent", () => {
  test("accepts optional vectorClock with non-negative integer components", () => {
    expect(isFederationSyncEvent({ ...evt(1), vectorClock: { "zone-b": 1 } })).toBe(true);
  });

  test("rejects malformed vectorClock components", () => {
    expect(isFederationSyncEvent({ ...evt(1), vectorClock: { "zone-b": -1 } })).toBe(false);
    expect(isFederationSyncEvent({ ...evt(1), vectorClock: { "zone-b": Number.NaN } })).toBe(false);
  });
});

describe("createNexusSyncClient", () => {
  /**
   * Build a NexusTransport whose `call` returns a fixed payload regardless of T.
   * The cast through `unknown` is the only way to satisfy the polymorphic
   * generic in test fixtures.
   */
  function makeTransport(handler: (method: string, params: Record<string, unknown>) => unknown): {
    transport: NexusTransport;
    calls: { method: string; params: Record<string, unknown> }[];
  } {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const callImpl = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      calls.push({ method, params });
      const value = handler(method, params);
      if (value instanceof Error) {
        const err: KoiError = { code: "EXTERNAL", message: value.message, retryable: true };
        return { ok: false, error: err };
      }
      // Test fixture only — caller chooses T; we trust the test author to pass
      // a value compatible with the asserted T.
      return { ok: true, value: value as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    return { transport, calls };
  }

  test("fetchDelta calls federation.sync_fetch_delta with cursor params", async () => {
    const events: readonly FederationSyncEvent[] = [evt(1), evt(2)];
    const { transport, calls } = makeTransport(() => events);
    const client = createNexusSyncClient({ transport });
    const result = await client.fetchDelta(baseCursor);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("federation.sync_fetch_delta");
    expect(calls[0]?.params.zoneId).toBe(ZB);
    expect(calls[0]?.params.lastSequence).toBe(0);
    expect(calls[0]?.params.maxEvents).toBe(100);
  });

  test("fetchDelta forwards explicit maxEvents", async () => {
    const { transport, calls } = makeTransport(() => []);
    const client = createNexusSyncClient({ transport });
    await client.fetchDelta(baseCursor, 50);
    expect(calls[0]?.params.maxEvents).toBe(50);
  });

  test("fetchDelta returns Result.error when payload is not an array", async () => {
    // Regression for #1372 review-loop pass-4 round 1: a non-array
    // payload from a buggy hub must surface as Result.error so the
    // sync engine counts it toward offlineAfterFailures, not throw
    // out of syncZone() and get swallowed by Promise.allSettled.
    const { transport } = makeTransport(() => ({ not: "an array" }));
    const client = createNexusSyncClient({ transport });
    const result = await client.fetchDelta(baseCursor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/non-array payload/);
  });

  test("fetchDelta returns Result.error when an event is malformed", async () => {
    const malformed = [{ kind: "test", originZoneId: "zb" /* missing seq/data */ }];
    const { transport } = makeTransport(() => malformed);
    const client = createNexusSyncClient({ transport });
    const result = await client.fetchDelta(baseCursor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/malformed event at index 0/);
  });

  test("publishEvents calls federation.sync_publish with events array", async () => {
    const events: readonly FederationSyncEvent[] = [evt(1)];
    const { transport, calls } = makeTransport(() => undefined);
    const client = createNexusSyncClient({ transport });
    const result = await client.publishEvents(events);
    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("federation.sync_publish");
    expect(calls[0]?.params.events).toEqual(events);
  });

  test("propagates transport errors as Result.error", async () => {
    const { transport } = makeTransport(() => new Error("boom"));
    const client = createNexusSyncClient({ transport });
    const result = await client.fetchDelta(baseCursor);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toBe("boom");
    }
  });
});
