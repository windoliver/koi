import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BASE_PATH,
  DEFAULT_DEGRADATION_CONFIG,
  DEFAULT_WRITE_QUEUE_CONFIG,
  validateGatewayNexusConfig,
} from "./config.js";

describe("config defaults", () => {
  test("degradation defaults sane", () => {
    expect(DEFAULT_DEGRADATION_CONFIG.failureThreshold).toBe(3);
    expect(DEFAULT_DEGRADATION_CONFIG.probeIntervalMs).toBe(10_000);
  });

  test("write queue defaults sane", () => {
    expect(DEFAULT_WRITE_QUEUE_CONFIG.maxQueueSize).toBe(1_000);
    expect(DEFAULT_WRITE_QUEUE_CONFIG.flushIntervalMs).toBe(500);
  });

  test("base path matches doc", () => {
    expect(DEFAULT_BASE_PATH).toBe("global/gateway/sessions");
  });
});

describe("validateGatewayNexusConfig", () => {
  test("empty config is valid", () => {
    const r = validateGatewayNexusConfig({});
    expect(r.ok).toBe(true);
  });

  test("rejects empty basePath", () => {
    const r = validateGatewayNexusConfig({ basePath: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("basePath");
  });

  test("rejects empty instanceId", () => {
    const r = validateGatewayNexusConfig({ instanceId: "" });
    expect(r.ok).toBe(false);
  });

  test("rejects degradation.failureThreshold < 1", () => {
    const r = validateGatewayNexusConfig({ degradation: { failureThreshold: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("failureThreshold");
  });

  test("rejects writeQueue.maxQueueSize < 1", () => {
    const r = validateGatewayNexusConfig({ writeQueue: { maxQueueSize: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("maxQueueSize");
  });

  test("rejects basePath with traversal segments", () => {
    const r = validateGatewayNexusConfig({ basePath: "x/../etc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("..");
  });

  test("rejects absolute basePath", () => {
    const r = validateGatewayNexusConfig({ basePath: "/etc/passwd" });
    expect(r.ok).toBe(false);
  });

  test("rejects basePath with control characters", () => {
    const r = validateGatewayNexusConfig({ basePath: "xy" });
    expect(r.ok).toBe(false);
  });

  test("accepts valid overrides", () => {
    const r = validateGatewayNexusConfig({
      instanceId: "gw-1",
      basePath: "x/y",
      degradation: { failureThreshold: 5, probeIntervalMs: 1_000 },
      writeQueue: { maxQueueSize: 50, flushIntervalMs: 100 },
    });
    expect(r.ok).toBe(true);
  });
});
