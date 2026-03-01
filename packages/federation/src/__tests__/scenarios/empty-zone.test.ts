/**
 * Scenario: Zone with no events — empty delta, cursor stays at 0.
 */
import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { createSyncEngine } from "../../sync-engine.js";
import { createMultiZoneHarness } from "../harness.js";

describe("empty zone", () => {
  test("sync against empty zone returns empty delta and cursor stays at 0", async () => {
    const harness = createMultiZoneHarness(["zone-a", "zone-b"]);

    // Zone A has no events
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
    expect(cursor?.lastSequence).toBe(0);

    const log = engine.getEventLog("zone-a");
    expect(log).toHaveLength(0);

    await engine[Symbol.asyncDispose]();
  });
});
