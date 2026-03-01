import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { validateFederationConfig } from "../config.js";
import { DEFAULT_FEDERATION_CONFIG } from "../types.js";

describe("validateFederationConfig", () => {
  const validBase = { localZoneId: zoneId("zone-a") };

  test("returns valid config with defaults filled", () => {
    const result = validateFederationConfig(validBase);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.localZoneId).toBe(zoneId("zone-a"));
    expect(result.value.pollIntervalMs).toBe(DEFAULT_FEDERATION_CONFIG.pollIntervalMs);
    expect(result.value.minPollIntervalMs).toBe(DEFAULT_FEDERATION_CONFIG.minPollIntervalMs);
    expect(result.value.maxPollIntervalMs).toBe(DEFAULT_FEDERATION_CONFIG.maxPollIntervalMs);
    expect(result.value.snapshotThreshold).toBe(DEFAULT_FEDERATION_CONFIG.snapshotThreshold);
    expect(result.value.clockPruneAfterMs).toBe(DEFAULT_FEDERATION_CONFIG.clockPruneAfterMs);
    expect(result.value.conflictResolution).toBe("lww");
    expect(result.value.remoteZones).toEqual([]);
  });

  test("preserves user-supplied values", () => {
    const result = validateFederationConfig({
      ...validBase,
      pollIntervalMs: 10_000,
      remoteZones: [zoneId("zone-b")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pollIntervalMs).toBe(10_000);
    expect(result.value.remoteZones).toEqual([zoneId("zone-b")]);
  });

  test("rejects empty localZoneId", () => {
    const result = validateFederationConfig({ localZoneId: zoneId("") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("localZoneId");
  });

  test("rejects non-positive pollIntervalMs", () => {
    const result = validateFederationConfig({ ...validBase, pollIntervalMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("pollIntervalMs");
  });

  test("rejects non-positive minPollIntervalMs", () => {
    const result = validateFederationConfig({ ...validBase, minPollIntervalMs: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("minPollIntervalMs");
  });

  test("rejects non-positive maxPollIntervalMs", () => {
    const result = validateFederationConfig({ ...validBase, maxPollIntervalMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("maxPollIntervalMs");
  });

  test("rejects minPollIntervalMs > maxPollIntervalMs", () => {
    const result = validateFederationConfig({
      ...validBase,
      minPollIntervalMs: 10_000,
      maxPollIntervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("minPollIntervalMs");
  });

  test("rejects non-positive snapshotThreshold", () => {
    const result = validateFederationConfig({ ...validBase, snapshotThreshold: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("snapshotThreshold");
  });

  test("rejects non-positive clockPruneAfterMs", () => {
    const result = validateFederationConfig({ ...validBase, clockPruneAfterMs: -100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("clockPruneAfterMs");
  });
});
