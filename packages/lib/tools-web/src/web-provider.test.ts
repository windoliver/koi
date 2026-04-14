import { describe, expect, test } from "bun:test";
import type { Agent, KoiError, Result } from "@koi/core";
import {
  COMPONENT_PRIORITY,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
} from "@koi/core";
import type { WebExecutor, WebFetchResult, WebSearchResult } from "./web-executor.js";
import { createWebProvider } from "./web-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_AGENT = {} as Agent;

function createMockExecutor(): WebExecutor {
  return {
    fetch: async (): Promise<Result<WebFetchResult, KoiError>> => ({
      ok: true,
      value: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: "ok",
        truncated: false,
        finalUrl: "https://example.com",
        cached: false,
      },
    }),
    search: async (): Promise<Result<readonly WebSearchResult[], KoiError>> => ({
      ok: true,
      value: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebProvider", () => {
  test("attaches 2 tools by default", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    const components = (await provider.attach(MOCK_AGENT)) as ReadonlyMap<string, unknown>;
    expect(components.size).toBe(2);
  });

  test("uses custom prefix", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      prefix: "internet",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    const components = (await provider.attach(MOCK_AGENT)) as ReadonlyMap<string, unknown>;
    const keys = [...components.keys()];
    expect(keys.some((k) => k.includes("internet_fetch"))).toBe(true);
    expect(keys.some((k) => k.includes("internet_search"))).toBe(true);
  });

  test("filters operations", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      policy: DEFAULT_UNSANDBOXED_POLICY,
      operations: ["fetch"],
    });
    const components = (await provider.attach(MOCK_AGENT)) as ReadonlyMap<string, unknown>;
    expect(components.size).toBe(1);
    const keys = [...components.keys()];
    expect(keys.some((k) => k.includes("fetch"))).toBe(true);
    expect(keys.some((k) => k.includes("search"))).toBe(false);
  });

  test("applies custom policy", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      policy: DEFAULT_SANDBOXED_POLICY,
    });
    const components = (await provider.attach(MOCK_AGENT)) as ReadonlyMap<string, unknown>;
    expect(components.size).toBe(2);
    // Tools are created with the provided policy; verify they exist
    for (const value of components.values()) {
      const tool = value as { policy: unknown };
      expect(tool.policy).toBe(DEFAULT_SANDBOXED_POLICY);
    }
  });

  test("has correct name", () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    expect(provider.name).toBe("web-tools");
  });

  test("has BUNDLED priority", () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });
});
