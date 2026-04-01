import { describe, expect, test } from "bun:test";
import { isBlockedAddress, validateWebhookUrl } from "./ssrf.js";

describe("validateWebhookUrl", () => {
  test("accepts valid HTTPS URL", () => {
    const result = validateWebhookUrl("https://example.com/webhook");
    expect(result.ok).toBe(true);
  });

  test("accepts HTTPS URL with port", () => {
    const result = validateWebhookUrl("https://hooks.example.com:8443/events");
    expect(result.ok).toBe(true);
  });

  test("rejects HTTP URL", () => {
    const result = validateWebhookUrl("http://example.com/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  test("allows HTTP localhost when allowInsecureLocalhost is true", () => {
    const result = validateWebhookUrl("http://localhost:3000/webhook", true);
    expect(result.ok).toBe(true);
  });

  test("rejects HTTP localhost when allowInsecureLocalhost is false", () => {
    const result = validateWebhookUrl("http://localhost:3000/webhook", false);
    expect(result.ok).toBe(false);
  });

  test("allows HTTP 127.0.0.1 when allowInsecureLocalhost is true", () => {
    const result = validateWebhookUrl("http://127.0.0.1:3000/webhook", true);
    expect(result.ok).toBe(true);
  });

  test("rejects non-localhost HTTP even with allowInsecureLocalhost", () => {
    const result = validateWebhookUrl("http://other.host/webhook", true);
    expect(result.ok).toBe(false);
  });

  // Private IP ranges
  test("rejects 10.x.x.x (private)", () => {
    const result = validateWebhookUrl("https://10.0.0.1/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private");
  });

  test("rejects 172.16.x.x (private)", () => {
    const result = validateWebhookUrl("https://172.16.0.1/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private");
  });

  test("rejects 172.31.x.x (private)", () => {
    const result = validateWebhookUrl("https://172.31.255.255/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private");
  });

  test("rejects 192.168.x.x (private)", () => {
    const result = validateWebhookUrl("https://192.168.1.1/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private");
  });

  test("rejects 127.x.x.x (loopback)", () => {
    const result = validateWebhookUrl("https://127.0.0.1/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
  });

  test("rejects 169.254.169.254 (AWS metadata / link-local)", () => {
    const result = validateWebhookUrl("https://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("link-local");
  });

  // IPv6
  test("rejects IPv6 loopback ::1", () => {
    const result = validateWebhookUrl("https://[::1]/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("IPv6");
  });

  test("rejects IPv6 link-local fe80:", () => {
    const result = validateWebhookUrl("https://[fe80::1]/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("IPv6");
  });

  // Invalid URLs
  test("rejects invalid URL", () => {
    const result = validateWebhookUrl("not-a-url");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  test("rejects unsupported protocol", () => {
    const result = validateWebhookUrl("ftp://example.com/webhook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported protocol");
  });
});

describe("isBlockedAddress", () => {
  test("blocks private IPv4 10.x", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
  });

  test("blocks link-local 169.254.x", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  test("blocks loopback 127.x", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
  });

  test("blocks IPv6 loopback", () => {
    expect(isBlockedAddress("::1")).toBe(true);
  });

  test("allows public IP", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });
});
