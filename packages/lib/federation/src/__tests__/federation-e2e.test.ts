import { describe, expect, test } from "bun:test";
import type { KoiError, Result, ZoneId } from "@koi/core";
import { zoneId } from "@koi/core";
import { createSyncEngine } from "../sync-engine.js";
import type { SyncClient } from "../sync-protocol.js";
import type { FederationSyncEvent } from "../types.js";

/**
 * In-memory hub that two zones share.
 *
 * `clientFor(remoteZoneId)` returns a SyncClient that the LOCAL zone uses to
 * pull events originating from `remoteZoneId`. Events are published into the
 * hub regardless of which client is used; fetchDelta filters by origin.
 */
function createInMemoryHub(): {
  readonly clientFor: (remoteZoneId: ZoneId) => SyncClient;
} {
  const events: FederationSyncEvent[] = [];

  const clientFor = (remote: ZoneId): SyncClient => ({
    fetchDelta: async (cursor) => {
      const visible = events.filter(
        (e) => e.originZoneId === remote && e.sequence > cursor.lastSequence,
      );
      const r: Result<readonly FederationSyncEvent[], KoiError> = { ok: true, value: visible };
      return r;
    },
    publishEvents: async (newEvents) => {
      for (const e of newEvents) events.push(e);
      const r: Result<void, KoiError> = { ok: true, value: undefined };
      return r;
    },
  });

  return { clientFor };
}

const ZA = zoneId("zone-a");
const ZB = zoneId("zone-b");

describe("federation e2e (in-memory hub, two zones)", () => {
  test("event published from zone A reaches zone B's onEvent on next sync", async () => {
    const hub = createInMemoryHub();

    const fromA = hub.clientFor(ZA);

    // Zone B watches for events originating from zone A
    const engineB = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([["zone-a", fromA]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
    });

    const received: FederationSyncEvent[] = [];
    engineB.onEvent((e) => received.push(e));

    // Publish from zone A (any client may publish into the shared hub)
    await fromA.publishEvents([
      {
        kind: "agent_spawn",
        originZoneId: ZA,
        sequence: 1,
        data: { agentId: "agent-1" },
        emittedAt: Date.now(),
      },
    ]);

    await engineB.sync();
    expect(received).toHaveLength(1);
    expect(received[0]?.originZoneId).toBe(ZA);
    expect(received[0]?.kind).toBe("agent_spawn");

    // Cursor advanced — second sync produces nothing new
    await engineB.sync();
    expect(received).toHaveLength(1);

    await engineB[Symbol.asyncDispose]();
  });

  test("network partition mid-stream: only contiguous prefix is delivered, gap stalls cursor until repaired", async () => {
    // Gap item 18: simulate a partition that drops sequence 2 from the
    // wire. The engine sees [1, 3] — must reject the entire batch as a
    // gap (cursor stays at 0). When the partition heals and the next
    // sync returns [1, 2, 3] cleanly, all three deliver in order.
    let partitioned = true;
    const allEvents: FederationSyncEvent[] = [
      { kind: "k1", originZoneId: ZA, sequence: 1, data: {}, emittedAt: 1 },
      { kind: "k2", originZoneId: ZA, sequence: 2, data: {}, emittedAt: 2 },
      { kind: "k3", originZoneId: ZA, sequence: 3, data: {}, emittedAt: 3 },
    ];
    const client: SyncClient = {
      fetchDelta: async (cursor) => {
        const after = allEvents.filter((e) => e.sequence > cursor.lastSequence);
        // While partitioned, drop seq=2 from the wire.
        const visible = partitioned ? after.filter((e) => e.sequence !== 2) : after;
        return { ok: true, value: visible };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };

    const engine = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([["zone-a", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 999,
    });
    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    // Gap rejected — nothing delivered, cursor still at 0.
    expect(received).toEqual([]);
    expect(engine.getCursor("zone-a")?.lastSequence ?? 0).toBe(0);

    // Heal the partition.
    partitioned = false;
    await engine.sync();
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);

    await engine[Symbol.asyncDispose]();
  });

  test("clock skew: events are ordered by sequence, not emittedAt — out-of-order timestamps still deliver in sequence order", async () => {
    // Gap item 19: a remote with clock skew may emit event seq=2 with a
    // smaller emittedAt than seq=1. Ordering MUST follow sequence (the
    // wire-protocol invariant), not emittedAt (an advisory timestamp).
    const skewed: FederationSyncEvent[] = [
      { kind: "k1", originZoneId: ZA, sequence: 1, data: {}, emittedAt: 1_000_000 },
      { kind: "k2", originZoneId: ZA, sequence: 2, data: {}, emittedAt: 5 },
      { kind: "k3", originZoneId: ZA, sequence: 3, data: {}, emittedAt: 999_999 },
    ];
    const client: SyncClient = {
      fetchDelta: async (cursor) => ({
        ok: true,
        value: skewed.filter((e) => e.sequence > cursor.lastSequence),
      }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([["zone-a", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
    });
    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    await engine[Symbol.asyncDispose]();
  });

  test("high-volume interleaved ordering: 1k events across 2 origins each deliver exactly once in per-origin sequence order", async () => {
    // Gap item 20: stress test for dedup + per-origin cursor isolation.
    // Two origins each publish 1000 events; engine pulls them across
    // multiple sync cycles. Each origin's events must arrive in sequence
    // order, no duplicates, no drops, even though the second origin's
    // sequence numbers overlap with the first's.
    const N = 1000;
    const eventsA: FederationSyncEvent[] = Array.from({ length: N }, (_, i) => ({
      kind: "fromA",
      originZoneId: ZA,
      sequence: i + 1,
      data: { i },
      emittedAt: i,
    }));
    const ZC = zoneId("zone-c");
    const eventsC: FederationSyncEvent[] = Array.from({ length: N }, (_, i) => ({
      kind: "fromC",
      originZoneId: ZC,
      sequence: i + 1,
      data: { i },
      emittedAt: i,
    }));

    // Each fetch returns at most CHUNK events so we exercise multi-cycle.
    const CHUNK = 137;
    const makeChunkedClient = (all: FederationSyncEvent[]): SyncClient => ({
      fetchDelta: async (cursor) => {
        const remaining = all.filter((e) => e.sequence > cursor.lastSequence);
        return { ok: true, value: remaining.slice(0, CHUNK) };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    });

    const engine = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([
        ["zone-a", makeChunkedClient(eventsA)],
        ["zone-c", makeChunkedClient(eventsC)],
      ]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
      eventLogMaxPerZone: Number.POSITIVE_INFINITY,
    });
    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    // Drain across enough sync cycles to exhaust both origins.
    const cycles = Math.ceil(N / CHUNK) + 2;
    for (let c = 0; c < cycles; c++) await engine.sync();

    const fromA = received.filter((e) => e.originZoneId === ZA);
    const fromC = received.filter((e) => e.originZoneId === ZC);
    expect(fromA).toHaveLength(N);
    expect(fromC).toHaveLength(N);
    expect(fromA.map((e) => e.sequence)).toEqual(eventsA.map((e) => e.sequence));
    expect(fromC.map((e) => e.sequence)).toEqual(eventsC.map((e) => e.sequence));

    // No duplicates: a re-sync after drain produces nothing new.
    const before = received.length;
    await engine.sync();
    expect(received).toHaveLength(before);

    await engine[Symbol.asyncDispose]();
  });
});
