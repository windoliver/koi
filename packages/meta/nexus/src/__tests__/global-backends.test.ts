/**
 * Tests for global backend creation.
 *
 * Registry and nameService are async (they call list_agents/name.list on startup)
 * and the fake-nexus-fetch doesn't support those methods. We test them
 * in disabled mode and test the remaining sync backends directly.
 */

import { describe, expect, test } from "bun:test";
import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createGlobalBackends } from "../global-backends.js";

const BASE_URL = "http://localhost:2026";
const API_KEY = "sk-test";

function createTestSetup(): {
  readonly conn: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly fetch: typeof globalThis.fetch;
  };
  readonly client: ReturnType<typeof createNexusClient>;
} {
  const fakeFetch = createFakeNexusFetch();
  const conn = { baseUrl: BASE_URL, apiKey: API_KEY, fetch: fakeFetch };
  const client = createNexusClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: fakeFetch });
  return { conn, client };
}

describe("createGlobalBackends", () => {
  test("creates sync backends by default (registry/nameService disabled)", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
    });

    expect(backends.registry).toBeUndefined();
    expect(backends.nameService).toBeUndefined();
    expect(backends.permissions).toBeDefined();
    expect(backends.audit).toBeDefined();
    expect(backends.search).toBeDefined();
    expect(backends.scheduler).toBeDefined();
    expect(backends.pay).toBeDefined();
  });

  test("disables permissions when overrides.permissions is false", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      permissions: false,
    });

    expect(backends.permissions).toBeUndefined();
    expect(backends.audit).toBeDefined();
  });

  test("disables audit when overrides.audit is false", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      audit: false,
    });

    expect(backends.audit).toBeUndefined();
  });

  test("disables search when overrides.search is false", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      search: false,
    });

    expect(backends.search).toBeUndefined();
  });

  test("disables scheduler when overrides.scheduler is false", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      scheduler: false,
    });

    expect(backends.scheduler).toBeUndefined();
  });

  test("disables pay when overrides.pay is false", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      pay: false,
    });

    expect(backends.pay).toBeUndefined();
  });

  test("disables all backends", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      permissions: false,
      audit: false,
      search: false,
      scheduler: false,
      pay: false,
      nameService: false,
    });

    expect(backends.registry).toBeUndefined();
    expect(backends.permissions).toBeUndefined();
    expect(backends.audit).toBeUndefined();
    expect(backends.search).toBeUndefined();
    expect(backends.scheduler).toBeUndefined();
    expect(backends.pay).toBeUndefined();
    expect(backends.nameService).toBeUndefined();
  });

  test("merges override config for scheduler", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      scheduler: { timeoutMs: 5_000, visibilityTimeoutMs: 60_000 },
    });

    expect(backends.scheduler).toBeDefined();
    expect(backends.scheduler?.taskStore).toBeDefined();
    expect(backends.scheduler?.scheduleStore).toBeDefined();
    expect(backends.scheduler?.queueBackend).toBeDefined();
  });

  test("merges override config for audit", async () => {
    const { conn, client } = createTestSetup();
    const backends = await createGlobalBackends(conn, client, {
      registry: false,
      nameService: false,
      audit: { batchSize: 200, flushIntervalMs: 10_000 },
    });

    expect(backends.audit).toBeDefined();
  });
});
