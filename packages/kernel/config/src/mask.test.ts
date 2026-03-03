import { describe, expect, test } from "bun:test";
import { maskConfig, SENSITIVE_PATTERN } from "./mask.js";

describe("maskConfig", () => {
  test("masks flat sensitive keys", () => {
    const config = { apiKey: "sk-123", logLevel: "info" };
    const result = maskConfig(config);
    expect(result.apiKey).toBe("***");
    expect(result.logLevel).toBe("info");
  });

  test("masks nested sensitive keys", () => {
    const config = { telemetry: { endpoint: "http://x", auth_token: "tok" } };
    const result = maskConfig(config);
    const nested = result.telemetry as Record<string, unknown>;
    expect(nested.endpoint).toBe("http://x");
    expect(nested.auth_token).toBe("***");
  });

  test("masks keys with various naming conventions", () => {
    const config = {
      api_key: "a",
      API_KEY: "b",
      apiKey: "c",
      secret: "d",
      password: "e",
      token: "f",
      credential: "g",
      authHeader: "h",
    };
    const result = maskConfig(config);
    for (const key of Object.keys(config)) {
      expect(result[key]).toBe("***");
    }
  });

  test("handles arrays by mapping elements", () => {
    const config = {
      providers: [
        { name: "openai", api_key: "sk-1" },
        { name: "anthropic", api_key: "sk-2" },
      ],
    };
    const result = maskConfig(config);
    const providers = result.providers as ReadonlyArray<Record<string, unknown>>;
    expect(providers[0]?.name).toBe("openai");
    expect(providers[0]?.api_key).toBe("***");
    expect(providers[1]?.name).toBe("anthropic");
    expect(providers[1]?.api_key).toBe("***");
  });

  test("supports custom pattern", () => {
    const config = { myCustomField: "secret", logLevel: "info" };
    const result = maskConfig(config, /myCustomField/i);
    expect(result.myCustomField).toBe("***");
    expect(result.logLevel).toBe("info");
  });

  test("preserves non-matching keys", () => {
    const config = { logLevel: "debug", limits: { maxTurns: 25 } };
    const result = maskConfig(config);
    expect(result.logLevel).toBe("debug");
    const limits = result.limits as Record<string, unknown>;
    expect(limits.maxTurns).toBe(25);
  });

  test("handles empty object", () => {
    const result = maskConfig({});
    expect(result).toEqual({});
  });

  test("does not mutate input", () => {
    const config = { apiKey: "sk-123", logLevel: "info" };
    const original = { ...config };
    maskConfig(config);
    expect(config).toEqual(original);
  });

  test("SENSITIVE_PATTERN matches expected patterns", () => {
    const matches = ["apiKey", "api_key", "secret", "password", "token", "credential", "auth"];
    const nonMatches = ["logLevel", "maxTurns", "enabled", "strategy"];
    for (const m of matches) {
      expect(SENSITIVE_PATTERN.test(m)).toBe(true);
    }
    for (const nm of nonMatches) {
      expect(SENSITIVE_PATTERN.test(nm)).toBe(false);
    }
  });
});
