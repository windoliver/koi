/**
 * Scenario: Zone A publishes 10 events while B is down; B recovers and syncs.
 */
import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { createSyncEngine } from "../../sync-engine.js";
import { createMultiZoneHarness, createTestEvent } from "../harness.js";

describe("partition recovery", () => {
  test("zone B catches up on all 10 events after recovery", async () => {
    const harness = createMultiZoneHarness(["zone-a", "zone-b"]);

    // Zone A publishes 10 events while B is "down"
    for (let i = 1; i <= 10; i++) {
      harness.publish("zone-a", createTestEvent("zone-a", i));
    }

    // Zone B comes back online and syncs
    const engine = createSyncEngine({
      localZoneId: zoneId("zone-b"),
      remoteClients: new Map([["zone-a", harness.getClient("zone-b")]]),
      pollIntervalMs: 100_000,
      minPollIntervalMs: 50,
      maxPollIntervalMs: 200_000,
      snapshotThreshold: 1000,
      clockPruneAfterMs: 86_400_000,
    });

    await engine.sync();

    const cursor = engine.getCursor("zone-a");
    expect(cursor?.lastSequence).toBe(10);

    const log = engine.getEventLog("zone-a");
    expect(log).toHaveLength(10);

    await engine[Symbol.asyncDispose]();
  });
});
