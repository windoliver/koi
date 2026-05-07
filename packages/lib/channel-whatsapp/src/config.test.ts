import { describe, expect, test } from "bun:test";
import { validateWhatsAppConfig } from "./config.js";

const baseConfig = {
  phoneNumberId: "123456789",
  accessToken: "EAAG_token",
  verifyToken: "verify-secret",
  appSecret: "app-secret",
};

describe("validateWhatsAppConfig", () => {
  test("accepts minimal config and applies defaults", () => {
    const r = validateWhatsAppConfig(baseConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.graphBaseUrl).toBe("https://graph.facebook.com/v18.0");
    expect(r.value.production).toBe(false);
    expect(r.value.handlerTimeoutMs).toBe(300_000);
    expect(r.value.commitTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("rejects empty phoneNumberId", () => {
    const r = validateWhatsAppConfig({ ...baseConfig, phoneNumberId: "" });
    expect(r.ok).toBe(false);
  });

  test("rejects empty accessToken", () => {
    const r = validateWhatsAppConfig({ ...baseConfig, accessToken: "" });
    expect(r.ok).toBe(false);
  });

  test("rejects empty verifyToken", () => {
    const r = validateWhatsAppConfig({ ...baseConfig, verifyToken: "" });
    expect(r.ok).toBe(false);
  });

  test("rejects empty appSecret", () => {
    const r = validateWhatsAppConfig({ ...baseConfig, appSecret: "" });
    expect(r.ok).toBe(false);
  });

  test("rejects non-https graphBaseUrl", () => {
    const r = validateWhatsAppConfig({ ...baseConfig, graphBaseUrl: "http://graph.example.com" });
    expect(r.ok).toBe(false);
  });

  test("accepts custom https graphBaseUrl", () => {
    const r = validateWhatsAppConfig({
      ...baseConfig,
      graphBaseUrl: "https://graph.facebook.com/v19.0",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.graphBaseUrl).toBe("https://graph.facebook.com/v19.0");
  });
});
