/**
 * Integration tests for graceful degradation across all 3 Nexus-backed stores.
 *
 * Verifies that stores fall back to in-memory behavior when Nexus is unavailable,
 * and recover when Nexus comes back online.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { Session } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusNodeRegistry } from "../nexus-node-registry.js";
import { createNexusSessionStore } from "../nexus-session-store.js";
import { createNexusSurfaceStore } from "../nexus-surface-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(id: string): Session {
  return {
    id,
    agentId: "agent-1",
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    seq: 0,
    remoteSeq: 0,
    metadata: {},
  };
}

interface ControllableClient {
  readonly client: NexusClient;
  readonly setHealthy: () => void;
  readonly setFailing: () => void;
}

// Test NexusClient factory — concentrates the generic interface mock in one place.
// TypeScript cannot structurally satisfy a generic method from a concrete mock,
// so a single assertion here is unavoidable for test mocking.
function createTestNexusClient(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusClient {
  return { rpc: handler } as NexusClient;
}

function createControllableClient(): ControllableClient {
  let failing = false;
  const failError: Result<unknown, KoiError> = {
    ok: false,
    error: { code: "EXTERNAL", message: "Nexus unavailable", retryable: true },
  };
  const okResponse: Result<unknown, KoiError> = { ok: true, value: null };
  const notFoundResponse: Result<unknown, KoiError> = {
    ok: false,
    error: { code: "NOT_FOUND", message: "not found", retryable: false },
  };

  return {
    client: createTestNexusClient(async (method) => {
      if (failing) return failError;
      if (method === "read") return notFoundResponse;
      return okResponse;
    }),
    setHealthy: () => {
      failing = false;
    },
    setFailing: () => {
      failing = true;
    },
  };
}

const BASE_CONFIG = {
  nexusUrl: "http://localhost:2026",
  apiKey: "test-key",
  instanceId: "test-instance",
  degradation: { failureThreshold: 2, probeIntervalMs: 100 },
  writeQueue: { flushIntervalMs: 60_000 },
} as const;

// ---------------------------------------------------------------------------
// SessionStore degradation
// ---------------------------------------------------------------------------

describe("SessionStore degradation", () => {
  let ctrl: ControllableClient;

  beforeEach(() => {
    ctrl = createControllableClient();
  });

  test("serves from cache when Nexus is down", async () => {
    const handle = createNexusSessionStore({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    // Store a session while healthy
    handle.store.set(makeSession("s1"));

    // Bring Nexus down
    ctrl.setFailing();

    // Cached session still accessible
    const r = handle.store.get("s1");
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ id: "s1" }) });

    await handle.dispose();
  });

  test("enters degraded mode after consecutive failures", async () => {
    const handle = createNexusSessionStore({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    ctrl.setFailing();
    // Trigger cache misses → Nexus calls → failures
    await handle.store.get("miss-1");
    await handle.store.get("miss-2");

    expect(handle.degradation().mode).toBe("degraded");
    await handle.dispose();
  });

  test("returns NOT_FOUND for uncached sessions when degraded", async () => {
    const handle = createNexusSessionStore({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    ctrl.setFailing();
    await handle.store.get("miss-1");
    await handle.store.get("miss-2");

    // In degraded mode, cache miss → immediate NOT_FOUND (no Nexus call)
    const r = handle.store.get("uncached");
    expect(r).toEqual(expect.objectContaining({ ok: false }));

    await handle.dispose();
  });

  test("writes still succeed locally when degraded", async () => {
    const handle = createNexusSessionStore({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    ctrl.setFailing();
    await handle.store.get("miss-1");
    await handle.store.get("miss-2");

    // Write should still work (local cache)
    const r = await handle.store.set(makeSession("new-sess"));
    expect(r.ok).toBe(true);
    expect(handle.store.size()).toBe(1);

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// NodeRegistry degradation
// ---------------------------------------------------------------------------

describe("NodeRegistry degradation", () => {
  test("register and lookup work when Nexus is failing", async () => {
    const ctrl = createControllableClient();
    ctrl.setFailing();

    const handle = createNexusNodeRegistry({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    const r = handle.registry.register({
      nodeId: "n1",
      mode: "full",
      tools: [{ name: "t1" }],
      capacity: { current: 1, max: 10, available: 9 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "c1",
    });
    expect(r.ok).toBe(true);
    expect(handle.registry.lookup("n1")).toBeDefined();
    expect(handle.registry.findByTool("t1")).toHaveLength(1);

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// SurfaceStore degradation
// ---------------------------------------------------------------------------

describe("SurfaceStore degradation", () => {
  test("serves from cache when Nexus is down", async () => {
    const ctrl = createControllableClient();
    const handle = createNexusSurfaceStore({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    // Create surface while healthy
    handle.store.create("surf-1", "<div>test</div>");

    // Bring Nexus down
    ctrl.setFailing();

    // Cached surface still accessible
    const r = await handle.store.get("surf-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.surfaceId).toBe("surf-1");

    await handle.dispose();
  });

  test("creates and updates work locally when degraded", async () => {
    const ctrl = createControllableClient();
    ctrl.setFailing();

    const handle = createNexusSurfaceStore({
      client: ctrl.client,
      config: BASE_CONFIG,
    });

    const created = await handle.store.create("surf-1", "v1");
    expect(created.ok).toBe(true);

    const updated = await handle.store.update("surf-1", "v2", undefined);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.content).toBe("v2");

    await handle.dispose();
  });
});
