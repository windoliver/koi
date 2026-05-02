import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFakeClient } from "./__tests__/fakes.js";
import { validateE2bConfig } from "./validate.js";

describe("validateE2bConfig", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = originalEnv;
  });

  test("returns VALIDATION error when API key missing and env unset", () => {
    const result = validateE2bConfig({ client: createFakeClient() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("E2B_API_KEY");
    }
  });

  test("falls back to E2B_API_KEY env var", () => {
    process.env.E2B_API_KEY = "env-key";
    const result = validateE2bConfig({ client: createFakeClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiKey).toBe("env-key");
  });

  test("explicit apiKey wins over env", () => {
    process.env.E2B_API_KEY = "env-key";
    const result = validateE2bConfig({ apiKey: "explicit", client: createFakeClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiKey).toBe("explicit");
  });

  test("rejects empty-string API key", () => {
    const result = validateE2bConfig({ apiKey: "", client: createFakeClient() });
    expect(result.ok).toBe(false);
  });

  test("preserves template when provided", () => {
    const result = validateE2bConfig({
      apiKey: "k",
      template: "tpl-1",
      client: createFakeClient(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.template).toBe("tpl-1");
  });

  test("requires client even when API key is present", () => {
    // @ts-expect-error — intentionally exercising the runtime guard
    const result = validateE2bConfig({ apiKey: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("client");
  });
});
