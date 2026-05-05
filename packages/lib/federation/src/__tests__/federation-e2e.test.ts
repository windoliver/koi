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
});
