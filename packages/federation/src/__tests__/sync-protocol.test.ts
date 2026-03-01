import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import {
  advanceCursor,
  createNexusSyncClient,
  deduplicateEvents,
  resolveConflict,
} from "../sync-protocol.js";
import type { FederationSyncEvent, SyncCursor } from "../types.js";

function createEvent(overrides?: Partial<FederationSyncEvent>): FederationSyncEvent {
  return {
    kind: "test_event",
    originZoneId: zoneId("zone-a"),
    sequence: 1,
    vectorClock: { "zone-a": 1 },
    data: {},
    emittedAt: 1000,
    ...overrides,
  };
}

function createCursor(overrides?: Partial<SyncCursor>): SyncCursor {
  return {
    zoneId: zoneId("zone-a"),
    vectorClock: {},
    lastSequence: 0,
    lastSyncAt: 0,
    ...overrides,
  };
}

describe("advanceCursor", () => {
  test("returns same cursor for empty events", () => {
    const cursor = createCursor();
    const result = advanceCursor(cursor, []);
    expect(result).toBe(cursor);
  });

  test("advances lastSequence to max event sequence", () => {
    const cursor = createCursor();
    const events = [
      createEvent({ sequence: 3 }),
      createEvent({ sequence: 1 }),
      createEvent({ sequence: 5 }),
    ];
    const result = advanceCursor(cursor, events);
    expect(result.lastSequence).toBe(5);
  });

  test("merges vector clocks from all events", () => {
    const cursor = createCursor({ vectorClock: { "zone-a": 1 } });
    const events = [
      createEvent({ vectorClock: { "zone-a": 2, "zone-b": 1 } }),
      createEvent({ vectorClock: { "zone-b": 3 } }),
    ];
    const result = advanceCursor(cursor, events);
    expect(result.vectorClock).toEqual({ "zone-a": 2, "zone-b": 3 });
  });

  test("updates lastSyncAt", () => {
    const cursor = createCursor({ lastSyncAt: 0 });
    const result = advanceCursor(cursor, [createEvent()]);
    expect(result.lastSyncAt).toBeGreaterThan(0);
  });

  test("preserves zoneId", () => {
    const cursor = createCursor({ zoneId: zoneId("zone-x") });
    const result = advanceCursor(cursor, [createEvent()]);
    expect(result.zoneId).toBe(zoneId("zone-x"));
  });
});

describe("deduplicateEvents", () => {
  test("filters events with sequence <= cursor.lastSequence", () => {
    const cursor = createCursor({ lastSequence: 5 });
    const events = [
      createEvent({ sequence: 3 }),
      createEvent({ sequence: 5 }),
      createEvent({ sequence: 6 }),
      createEvent({ sequence: 8 }),
    ];
    const result = deduplicateEvents(events, cursor);
    expect(result).toHaveLength(2);
    expect(result[0]?.sequence).toBe(6);
    expect(result[1]?.sequence).toBe(8);
  });

  test("returns empty for all-seen events", () => {
    const cursor = createCursor({ lastSequence: 10 });
    const events = [createEvent({ sequence: 5 }), createEvent({ sequence: 10 })];
    expect(deduplicateEvents(events, cursor)).toHaveLength(0);
  });

  test("returns all for fresh cursor", () => {
    const cursor = createCursor({ lastSequence: 0 });
    const events = [createEvent({ sequence: 1 }), createEvent({ sequence: 2 })];
    expect(deduplicateEvents(events, cursor)).toHaveLength(2);
  });
});

describe("resolveConflict", () => {
  test("picks event with later emittedAt (LWW)", () => {
    const local = createEvent({ emittedAt: 1000, originZoneId: zoneId("zone-a") });
    const remote = createEvent({ emittedAt: 2000, originZoneId: zoneId("zone-b") });
    expect(resolveConflict(local, remote)).toBe(remote);
  });

  test("picks local when local emittedAt is later", () => {
    const local = createEvent({ emittedAt: 3000, originZoneId: zoneId("zone-a") });
    const remote = createEvent({ emittedAt: 2000, originZoneId: zoneId("zone-b") });
    expect(resolveConflict(local, remote)).toBe(local);
  });

  test("tie-breaks by zone ID (lexicographic, higher wins)", () => {
    const local = createEvent({
      emittedAt: 1000,
      originZoneId: zoneId("zone-b"),
    });
    const remote = createEvent({
      emittedAt: 1000,
      originZoneId: zoneId("zone-a"),
    });
    expect(resolveConflict(local, remote)).toBe(local); // "zone-b" > "zone-a"
  });
});

describe("createNexusSyncClient", () => {
  test("fetchDelta calls rpc with correct params", async () => {
    const mockRpc = async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("federation.sync_fetch_delta");
      expect(params.zoneId).toBe("zone-a");
      expect(params.lastSequence).toBe(5);
      return { ok: true as const, value: [] };
    };
    const client = createNexusSyncClient({ client: { rpc: mockRpc as NexusClient["rpc"] } });
    const result = await client.fetchDelta(createCursor({ lastSequence: 5 }));
    expect(result.ok).toBe(true);
  });

  test("publishEvents calls rpc with events", async () => {
    const events = [createEvent()];
    const mockRpc = async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("federation.sync_publish");
      expect(params.events).toBe(events);
      return { ok: true as const, value: undefined };
    };
    const client = createNexusSyncClient({ client: { rpc: mockRpc as NexusClient["rpc"] } });
    const result = await client.publishEvents(events);
    expect(result.ok).toBe(true);
  });
});
