import { describe, expect, test } from "bun:test";
import { validateVercelConfig } from "./validate.js";

describe("validateVercelConfig", () => {
  test("returns ok with valid apiToken", () => {
    const result = validateVercelConfig({ apiToken: "test-token" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiToken).toBe("test-token");
    }
  });

  test("falls back to VERCEL_TOKEN env var", () => {
    const original = process.env.VERCEL_TOKEN;
    process.env.VERCEL_TOKEN = "env-token";
    try {
      const result = validateVercelConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.apiToken).toBe("env-token");
      }
    } finally {
      if (original !== undefined) {
        process.env.VERCEL_TOKEN = original;
      } else {
        delete process.env.VERCEL_TOKEN;
      }
    }
  });

  test("returns error when no apiToken provided", () => {
    const original = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      const result = validateVercelConfig({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    } finally {
      if (original !== undefined) {
        process.env.VERCEL_TOKEN = original;
      }
    }
  });

  test("preserves teamId and projectId", () => {
    const result = validateVercelConfig({
      apiToken: "token",
      teamId: "team-1",
      projectId: "proj-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.teamId).toBe("team-1");
      expect(result.value.projectId).toBe("proj-1");
    }
  });
});
