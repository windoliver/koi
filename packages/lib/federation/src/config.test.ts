import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { validateFederationConfig } from "./config.js";

describe("validateFederationConfig", () => {
  test("returns ok with defaults when only localZoneId provided", () => {
    const result = validateFederationConfig({ localZoneId: zoneId("zone-a") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.localZoneId).toBe(zoneId("zone-a"));
      expect(result.value.pollIntervalMs).toBe(5_000);
      expect(result.value.offlineAfterFailures).toBe(3);
      expect(result.value.conflictResolution).toBe("lww");
      expect(result.value.remoteZones).toEqual([]);
    }
  });

  test("rejects empty localZoneId", () => {
    const result = validateFederationConfig({ localZoneId: zoneId("") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("localZoneId");
    }
  });

  test("rejects non-positive pollIntervalMs", () => {
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      pollIntervalMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("pollIntervalMs");
    }
  });

  test("rejects negative pollIntervalMs", () => {
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      pollIntervalMs: -1,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer offlineAfterFailures", () => {
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      offlineAfterFailures: 2.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("offlineAfterFailures");
    }
  });

  test("rejects zero offlineAfterFailures", () => {
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      offlineAfterFailures: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("preserves user-provided remoteZones", () => {
    const remoteZones = [zoneId("zone-b"), zoneId("zone-c")];
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      remoteZones,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.remoteZones).toEqual(remoteZones);
    }
  });

  test("preserves supported conflict resolution strategy", () => {
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      conflictResolution: "manual",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conflictResolution).toBe("manual");
    }
  });

  test("rejects unsupported conflict resolution strategy", () => {
    const result = validateFederationConfig({
      localZoneId: zoneId("zone-a"),
      // @ts-expect-error exercising runtime validation for malformed input
      conflictResolution: "newest",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("conflictResolution");
    }
  });
});
