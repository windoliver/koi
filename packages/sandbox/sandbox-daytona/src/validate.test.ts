import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFakeClient } from "./__tests__/fakes.js";
import { validateDaytonaConfig } from "./validate.js";

describe("validateDaytonaConfig", () => {
  let originalKey: string | undefined;
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalKey = process.env.DAYTONA_API_KEY;
    originalUrl = process.env.DAYTONA_API_URL;
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_URL;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DAYTONA_API_KEY;
    else process.env.DAYTONA_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.DAYTONA_API_URL;
    else process.env.DAYTONA_API_URL = originalUrl;
  });

  test("returns VALIDATION error when API key missing and env unset", () => {
    const result = validateDaytonaConfig({ client: createFakeClient() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("DAYTONA_API_KEY");
    }
  });

  test("falls back to env vars for key and URL", () => {
    process.env.DAYTONA_API_KEY = "env-key";
    process.env.DAYTONA_API_URL = "https://api.example";
    const result = validateDaytonaConfig({ client: createFakeClient() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("env-key");
      expect(result.value.apiUrl).toBe("https://api.example");
    }
  });

  test("explicit values win over env", () => {
    process.env.DAYTONA_API_KEY = "env-key";
    const result = validateDaytonaConfig({
      apiKey: "explicit",
      apiUrl: "https://explicit",
      target: "eu",
      client: createFakeClient(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("explicit");
      expect(result.value.apiUrl).toBe("https://explicit");
      expect(result.value.target).toBe("eu");
    }
  });

  test("defaults target to 'us' when unspecified", () => {
    const result = validateDaytonaConfig({ apiKey: "k", client: createFakeClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.target).toBe("us");
  });

  test("rejects empty-string API key", () => {
    const result = validateDaytonaConfig({ apiKey: "", client: createFakeClient() });
    expect(result.ok).toBe(false);
  });

  test("requires client even when API key is present", () => {
    // @ts-expect-error — intentionally exercising the runtime guard
    const result = validateDaytonaConfig({ apiKey: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("client");
  });

  test("omits apiUrl when neither config nor env provides one", () => {
    const result = validateDaytonaConfig({ apiKey: "k", client: createFakeClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiUrl).toBeUndefined();
  });
});
