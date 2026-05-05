import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { advanceCursor, createNexusSyncClient, deduplicateEvents } from "./sync-protocol.js";
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
    const next = advanceCursor(baseCursor, [], 12_345);
    expect(next.lastSequence).toBe(0);
    expect(next.lastSyncAt).toBe(12_345);
    expect(next.zoneId).toBe(ZB);
  });

  test("advances lastSequence to max sequence in batch", () => {
    const next = advanceCursor(baseCursor, [evt(1), evt(3), evt(2)], 999);
    expect(next.lastSequence).toBe(3);
    expect(next.lastSyncAt).toBe(999);
  });

  test("never moves lastSequence backward", () => {
    const cursor: SyncCursor = { zoneId: ZB, lastSequence: 10, lastSyncAt: 0 };
    const next = advanceCursor(cursor, [evt(2), evt(5)]);
    expect(next.lastSequence).toBe(10);
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
    expect(calls[0]?.params["zoneId"]).toBe(ZB);
    expect(calls[0]?.params["lastSequence"]).toBe(0);
    expect(calls[0]?.params["maxEvents"]).toBe(100);
  });

  test("fetchDelta forwards explicit maxEvents", async () => {
    const { transport, calls } = makeTransport(() => []);
    const client = createNexusSyncClient({ transport });
    await client.fetchDelta(baseCursor, 50);
    expect(calls[0]?.params["maxEvents"]).toBe(50);
  });

  test("publishEvents calls federation.sync_publish with events array", async () => {
    const events: readonly FederationSyncEvent[] = [evt(1)];
    const { transport, calls } = makeTransport(() => undefined);
    const client = createNexusSyncClient({ transport });
    const result = await client.publishEvents(events);
    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("federation.sync_publish");
    expect(calls[0]?.params["events"]).toEqual(events);
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
