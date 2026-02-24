import { describe, expect, test } from "bun:test";
import { DEFAULT_WEBHOOK_DELIVERY_CONFIG, validateWebhookDeliveryConfig } from "./config.js";

describe("DEFAULT_WEBHOOK_DELIVERY_CONFIG", () => {
  test("has sane defaults", () => {
    expect(DEFAULT_WEBHOOK_DELIVERY_CONFIG.maxConcurrentDeliveries).toBe(10);
    expect(DEFAULT_WEBHOOK_DELIVERY_CONFIG.requestTimeoutMs).toBe(10_000);
    expect(DEFAULT_WEBHOOK_DELIVERY_CONFIG.maxRetries).toBe(5);
    expect(DEFAULT_WEBHOOK_DELIVERY_CONFIG.maxResponseBodyBytes).toBe(4096);
  });
});

describe("validateWebhookDeliveryConfig", () => {
  test("valid config returns no errors", () => {
    const errors = validateWebhookDeliveryConfig(DEFAULT_WEBHOOK_DELIVERY_CONFIG);
    expect(errors).toEqual([]);
  });

  test("partial valid config returns no errors", () => {
    const errors = validateWebhookDeliveryConfig({ maxConcurrentDeliveries: 5 });
    expect(errors).toEqual([]);
  });

  test("rejects maxConcurrentDeliveries < 1", () => {
    const errors = validateWebhookDeliveryConfig({ maxConcurrentDeliveries: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("maxConcurrentDeliveries");
  });

  test("rejects requestTimeoutMs < 100", () => {
    const errors = validateWebhookDeliveryConfig({ requestTimeoutMs: 50 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("requestTimeoutMs");
  });

  test("rejects negative maxRetries", () => {
    const errors = validateWebhookDeliveryConfig({ maxRetries: -1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("maxRetries");
  });

  test("rejects negative maxResponseBodyBytes", () => {
    const errors = validateWebhookDeliveryConfig({ maxResponseBodyBytes: -1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("maxResponseBodyBytes");
  });

  test("returns multiple errors for multiple invalid fields", () => {
    const errors = validateWebhookDeliveryConfig({
      maxConcurrentDeliveries: 0,
      requestTimeoutMs: 0,
      maxRetries: -1,
    });
    expect(errors).toHaveLength(3);
  });
});
