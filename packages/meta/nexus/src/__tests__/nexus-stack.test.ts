/**
 * Tests for the main createNexusStack factory.
 *
 * Registry and nameService are disabled in tests because fake-nexus-fetch
 * doesn't support their startup RPC methods (list_agents, name.list).
 */

import { describe, expect, test } from "bun:test";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createNexusStack } from "../nexus-stack.js";

const BASE_URL = "http://localhost:2026";
const API_KEY = "sk-test";

/** Base config that disables async backends for testing. */
function testConfig(extra: Record<string, unknown> = {}): {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly overrides: { readonly registry: false; readonly nameService: false };
  readonly [key: string]: unknown;
} {
  return {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: createFakeNexusFetch(),
    overrides: { registry: false, nameService: false },
    ...extra,
  };
}

describe("createNexusStack", () => {
  test("creates a complete bundle with defaults", async () => {
    const bundle = await createNexusStack(testConfig());

    expect(bundle.backends).toBeDefined();
    expect(bundle.providers).toHaveLength(1);
    expect(bundle.client).toBeDefined();
    expect(bundle.config).toBeDefined();
    expect(typeof bundle.dispose).toBe("function");
  });

  test("config metadata reports correct values", async () => {
    const bundle = await createNexusStack(testConfig());

    expect(bundle.config.baseUrl).toBe(BASE_URL);
    // 5 backends enabled (permissions, audit, search, scheduler, pay)
    expect(bundle.config.globalBackendCount).toBe(5);
    expect(bundle.config.gatewayEnabled).toBe(false);
    expect(bundle.config.workspaceEnabled).toBe(false);
  });

  test("opt-in gateway updates metadata", async () => {
    const bundle = await createNexusStack({
      ...testConfig(),
      optIn: { gateway: {} },
    });

    expect(bundle.config.gatewayEnabled).toBe(true);
  });

  test("opt-in workspace updates metadata", async () => {
    const bundle = await createNexusStack({
      ...testConfig(),
      optIn: { workspace: {} },
    });

    expect(bundle.config.workspaceEnabled).toBe(true);
  });

  test("disabling backends reduces global count", async () => {
    const bundle = await createNexusStack({
      ...testConfig(),
      overrides: {
        registry: false,
        audit: false,
        nameService: false,
        pay: false,
      },
    });

    expect(bundle.config.globalBackendCount).toBe(3);
    expect(bundle.backends.registry).toBeUndefined();
    expect(bundle.backends.audit).toBeUndefined();
    expect(bundle.backends.nameService).toBeUndefined();
    expect(bundle.backends.pay).toBeUndefined();
  });

  test("throws on invalid config — empty baseUrl", async () => {
    await expect(createNexusStack({ baseUrl: "", apiKey: "sk-test" })).rejects.toThrow("baseUrl");
  });

  test("throws on invalid config — empty apiKey", async () => {
    await expect(createNexusStack({ baseUrl: BASE_URL, apiKey: "" })).rejects.toThrow("apiKey");
  });

  test("dispose is callable without error", async () => {
    const bundle = await createNexusStack(testConfig());

    // Should not throw
    await bundle.dispose();
  });

  test("providers array contains exactly one agent provider", async () => {
    const bundle = await createNexusStack(testConfig());

    expect(bundle.providers).toHaveLength(1);
    expect(bundle.providers[0]?.name).toBe("nexus-agent");
  });

  test("middlewares array is initially empty (no scratchpad without agents)", async () => {
    const bundle = await createNexusStack(testConfig());

    // Middlewares are collected when agents with groupId are attached
    expect(bundle.middlewares).toHaveLength(0);
  });
});
