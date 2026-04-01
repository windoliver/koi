/**
 * Scenario: Third zone added dynamically — starts from sequence 0, catches up.
 */
import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { createSyncEngine } from "../../sync-engine.js";
import { createMultiZoneHarness, createTestEvent } from "../harness.js";

describe("zone joins mid-sync", () => {
  test("new zone starts from sequence 0 and catches up", async () => {
    const harness = createMultiZoneHarness(["zone-a", "zone-b", "zone-c"]);

    // Zone A has existing events
    for (let i = 1; i <= 5; i++) {
      harness.publish("zone-a", createTestEvent("zone-a", i));
    }

    // Zone C joins late — only monitoring zone-a
    const engine = createSyncEngine({
      localZoneId: zoneId("zone-c"),
      remoteClients: new Map([["zone-a", harness.getClient("zone-c")]]),
      pollIntervalMs: 100_000,
      minPollIntervalMs: 50,
      maxPollIntervalMs: 200_000,
      snapshotThreshold: 1000,
      clockPruneAfterMs: 86_400_000,
    });

    // Initial cursor should be at sequence 0
    const initialCursor = engine.getCursor("zone-a");
    expect(initialCursor?.lastSequence).toBe(0);

    // After sync, should have all 5 events
    await engine.sync();

    const cursor = engine.getCursor("zone-a");
    expect(cursor?.lastSequence).toBe(5);

    const log = engine.getEventLog("zone-a");
    expect(log).toHaveLength(5);

    await engine[Symbol.asyncDispose]();
  });
});
