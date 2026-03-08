/**
 * Tests for resolve-nexus — verifies URL priority logic and graceful fallback.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @koi/nexus to avoid real network calls
// ---------------------------------------------------------------------------

const mockCreateNexusStack = mock(async (_config: Record<string, unknown>) => ({
  middlewares: [],
  providers: [],
  dispose: async () => {},
  config: { baseUrl: "http://localhost:2026" },
}));

mock.module("@koi/nexus", () => ({
  createNexusStack: mockCreateNexusStack,
}));

const { resolveNexusStack, resolveNexusOrWarn } = await import("./resolve-nexus.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  mockCreateNexusStack.mockClear();
  delete process.env.NEXUS_URL;
  delete process.env.NEXUS_API_KEY;
});

// ---------------------------------------------------------------------------
// resolveNexusStack — URL priority
// ---------------------------------------------------------------------------

describe("resolveNexusStack — URL priority", () => {
  test("CLI flag takes priority over env var", async () => {
    process.env.NEXUS_URL = "http://env-url:2026";

    await resolveNexusStack("http://flag-url:2026", undefined);

    expect(mockCreateNexusStack).toHaveBeenCalledTimes(1);
    const config = mockCreateNexusStack.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseUrl).toBe("http://flag-url:2026");
  });

  test("env var used when no CLI flag", async () => {
    process.env.NEXUS_URL = "http://env-url:2026";

    await resolveNexusStack(undefined, undefined);

    const config = mockCreateNexusStack.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseUrl).toBe("http://env-url:2026");
  });

  test("manifest nexus.url used when no CLI flag or env var", async () => {
    await resolveNexusStack(undefined, "http://manifest-url:2026");

    const config = mockCreateNexusStack.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseUrl).toBe("http://manifest-url:2026");
  });

  test("env var takes priority over manifest nexus.url", async () => {
    process.env.NEXUS_URL = "http://env-url:2026";

    await resolveNexusStack(undefined, "http://manifest-url:2026");

    const config = mockCreateNexusStack.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseUrl).toBe("http://env-url:2026");
  });

  test("no URL → embed mode (no baseUrl passed)", async () => {
    await resolveNexusStack(undefined, undefined);

    const config = mockCreateNexusStack.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseUrl).toBeUndefined();
  });

  test("passes apiKey from env", async () => {
    process.env.NEXUS_API_KEY = "test-api-key";

    await resolveNexusStack("http://flag-url:2026", undefined);

    const config = mockCreateNexusStack.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.apiKey).toBe("test-api-key");
  });

  test("returns NexusResolution with correct fields", async () => {
    const result = await resolveNexusStack(undefined, undefined);

    expect(result.middlewares).toEqual([]);
    expect(result.providers).toEqual([]);
    expect(typeof result.dispose).toBe("function");
    expect(result.baseUrl).toBe("http://localhost:2026");
  });
});

// ---------------------------------------------------------------------------
// resolveNexusOrWarn — graceful fallback
// ---------------------------------------------------------------------------

describe("resolveNexusOrWarn — graceful fallback", () => {
  test("returns Nexus state on success", async () => {
    const result = await resolveNexusOrWarn("http://localhost:2026", undefined, false);

    expect(result.middlewares).toEqual([]);
    expect(result.providers).toEqual([]);
    expect(result.dispose).toBeDefined();
    expect(result.baseUrl).toBe("http://localhost:2026");
  });

  test("returns empty defaults on failure", async () => {
    mockCreateNexusStack.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });

    const stderrChunks: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await resolveNexusOrWarn(undefined, undefined, false);

      expect(result.middlewares).toEqual([]);
      expect(result.providers).toEqual([]);
      expect(result.dispose).toBeUndefined();
      expect(result.baseUrl).toBeUndefined();

      const output = stderrChunks.join("");
      expect(output).toContain("warn: Nexus initialization failed");
      expect(output).toContain("connection refused");
    } finally {
      process.stderr.write = original;
    }
  });

  test("logs baseUrl in verbose mode", async () => {
    const stderrChunks: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await resolveNexusOrWarn("http://localhost:2026", undefined, true);
      const output = stderrChunks.join("");
      expect(output).toContain("Nexus: http://localhost:2026");
    } finally {
      process.stderr.write = original;
    }
  });
});
