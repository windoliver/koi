import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { createStaticZoneHealthMonitor, createZoneRouter, pickHealthyZone } from "./zone-router.js";

describe("pickHealthyZone", () => {
  test("selects the lowest-latency healthy zone", () => {
    const selected = pickHealthyZone([
      { zoneId: zoneId("zone-far"), status: "active", latencyMs: 80 },
      { zoneId: zoneId("zone-near"), status: "active", latencyMs: 12 },
      { zoneId: zoneId("zone-mid"), status: "active", latencyMs: 35 },
    ]);

    expect(selected?.zoneId).toBe(zoneId("zone-near"));
  });

  test("bypasses unhealthy zones even when they are nearest", () => {
    const selected = pickHealthyZone([
      { zoneId: zoneId("zone-near"), status: "offline", latencyMs: 1 },
      { zoneId: zoneId("zone-mid"), status: "draining", latencyMs: 8 },
      { zoneId: zoneId("zone-far"), status: "active", latencyMs: 40 },
    ]);

    expect(selected?.zoneId).toBe(zoneId("zone-far"));
  });
});

describe("createZoneRouter", () => {
  test("routes by live health snapshot and updates when zone health changes", () => {
    const monitor = createStaticZoneHealthMonitor([
      { zoneId: zoneId("zone-a"), status: "active", latencyMs: 50 },
      { zoneId: zoneId("zone-b"), status: "active", latencyMs: 10 },
    ]);
    const router = createZoneRouter({ monitor });

    expect(router.selectZone({ toolId: "bash" })?.zoneId).toBe(zoneId("zone-b"));

    monitor.setHealth(zoneId("zone-b"), { status: "offline", latencyMs: 10 });

    expect(router.selectZone({ toolId: "bash" })?.zoneId).toBe(zoneId("zone-a"));
  });

  test("returns undefined when every known zone is unhealthy", () => {
    const router = createZoneRouter({
      monitor: createStaticZoneHealthMonitor([
        { zoneId: zoneId("zone-a"), status: "offline", latencyMs: 5 },
        { zoneId: zoneId("zone-b"), status: "draining", latencyMs: 10 },
      ]),
    });

    expect(router.selectZone({ toolId: "bash" })).toBeUndefined();
  });
});
