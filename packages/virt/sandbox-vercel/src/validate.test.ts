import { describe, expect, mock, test } from "bun:test";
import type { VercelClient } from "./types.js";
import { validateVercelConfig } from "./validate.js";

const mockClient: VercelClient = {
  createSandbox: mock(() =>
    Promise.resolve({} as Awaited<ReturnType<VercelClient["createSandbox"]>>),
  ),
};

describe("validateVercelConfig", () => {
  test("returns error when client not provided", () => {
    const result = validateVercelConfig({ apiToken: "key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("returns ok with valid apiToken and client", () => {
    const result = validateVercelConfig({ apiToken: "test-token", client: mockClient });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiToken).toBe("test-token");
    }
  });

  test("falls back to VERCEL_TOKEN env var", () => {
    const original = process.env.VERCEL_TOKEN;
    process.env.VERCEL_TOKEN = "env-token";
    try {
      const result = validateVercelConfig({ client: mockClient });
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
      const result = validateVercelConfig({ client: mockClient });
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
      client: mockClient,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.teamId).toBe("team-1");
      expect(result.value.projectId).toBe("proj-1");
    }
  });
});
