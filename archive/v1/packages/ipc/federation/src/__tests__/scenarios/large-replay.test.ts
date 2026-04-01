/**
 * Scenario: Publish snapshotThreshold + 1 events — event log truncated to threshold/2.
 */
import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { createSyncEngine } from "../../sync-engine.js";
import { createMultiZoneHarness, createTestEvent } from "../harness.js";

describe("large replay", () => {
  test("event log truncated to threshold/2 when exceeding snapshotThreshold", async () => {
    const threshold = 20;
    const harness = createMultiZoneHarness(["zone-a", "zone-b"]);

    // Publish threshold + 1 events
    for (let i = 1; i <= threshold + 1; i++) {
      harness.publish("zone-a", createTestEvent("zone-a", i));
    }

    const engine = createSyncEngine({
      localZoneId: zoneId("zone-b"),
      remoteClients: new Map([["zone-a", harness.getClient("zone-b")]]),
      pollIntervalMs: 100_000,
      minPollIntervalMs: 50,
      maxPollIntervalMs: 200_000,
      snapshotThreshold: threshold,
      clockPruneAfterMs: 86_400_000,
    });

    await engine.sync();

    const log = engine.getEventLog("zone-a");
    const keepCount = Math.floor(threshold / 2);
    expect(log).toHaveLength(keepCount);

    // Newest events should be kept
    expect(log[log.length - 1]?.sequence).toBe(threshold + 1);
    expect(log[0]?.sequence).toBe(threshold + 1 - keepCount + 1);

    // Cursor should still reflect the latest sequence
    const cursor = engine.getCursor("zone-a");
    expect(cursor?.lastSequence).toBe(threshold + 1);

    await engine[Symbol.asyncDispose]();
  });
});
