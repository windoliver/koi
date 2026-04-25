import { describe, expect, test } from "bun:test";
import * as api from "../index.js";

describe("@koi/gateway-webhook public API", () => {
  test("exports createWebhookServer", () => {
    expect(typeof api.createWebhookServer).toBe("function");
  });

  test("exports createIdempotencyStore", () => {
    expect(typeof api.createIdempotencyStore).toBe("function");
  });

  test("exports provider utilities", () => {
    expect(typeof api.getProvider).toBe("function");
    expect(typeof api.isKnownProvider).toBe("function");
    expect(api.ALL_PROVIDERS).toBeInstanceOf(Map);
  });

  test("exports signing verifiers", () => {
    expect(typeof api.verifyGitHubSignature).toBe("function");
    expect(typeof api.verifySlackSignature).toBe("function");
    expect(typeof api.verifyStripeSignature).toBe("function");
    expect(typeof api.verifyGenericSignature).toBe("function");
  });

  test("isKnownProvider recognizes built-in providers", () => {
    expect(api.isKnownProvider("github")).toBe(true);
    expect(api.isKnownProvider("slack")).toBe(true);
    expect(api.isKnownProvider("stripe")).toBe(true);
    expect(api.isKnownProvider("generic")).toBe(true);
    expect(api.isKnownProvider("twitter")).toBe(false);
    expect(api.isKnownProvider("")).toBe(false);
  });

  test("ALL_PROVIDERS has exactly the 4 built-in providers", () => {
    expect(api.ALL_PROVIDERS.size).toBe(4);
    const kinds = [...api.ALL_PROVIDERS.keys()];
    expect(kinds).toContain("github");
    expect(kinds).toContain("slack");
    expect(kinds).toContain("stripe");
    expect(kinds).toContain("generic");
  });
});
