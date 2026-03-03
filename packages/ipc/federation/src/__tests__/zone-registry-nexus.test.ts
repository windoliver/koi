import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { KoiError, Result, ZoneDescriptor, ZoneEvent, ZoneRegistry } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createZoneRegistryNexus } from "../zone-registry-nexus.js";

function createMockClient(): NexusClient & {
  readonly rpcMock: ReturnType<typeof mock>;
} {
  const rpcMock = mock(() => Promise.resolve({ ok: true, value: {} }));
  return {
    rpc: rpcMock as NexusClient["rpc"],
    rpcMock,
  };
}

function createDescriptor(id: string): ZoneDescriptor {
  return {
    zoneId: zoneId(id),
    displayName: `Zone ${id}`,
    status: "active",
    metadata: {},
    registeredAt: Date.now(),
  };
}

describe("createZoneRegistryNexus", () => {
  let client: ReturnType<typeof createMockClient>;
  let registry: ZoneRegistry;

  beforeEach(() => {
    client = createMockClient();
    registry = createZoneRegistryNexus({ client });
  });

  test("register stores descriptor and notifies watchers", async () => {
    const descriptor = createDescriptor("zone-a");
    const events: ZoneEvent[] = [];
    registry.watch((e) => {
      events.push(e);
    });

    const result = await registry.register(descriptor);
    expect(result).toEqual(descriptor);
    expect(client.rpcMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("zone_registered");
  });

  test("deregister removes descriptor and notifies watchers", async () => {
    const descriptor = createDescriptor("zone-a");
    await registry.register(descriptor);

    const events: ZoneEvent[] = [];
    registry.watch((e) => {
      events.push(e);
    });

    const existed = await registry.deregister(zoneId("zone-a"));
    expect(existed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("zone_deregistered");
  });

  test("lookup returns registered descriptor", async () => {
    const descriptor = createDescriptor("zone-a");
    await registry.register(descriptor);

    const found = await registry.lookup(zoneId("zone-a"));
    expect(found).toEqual(descriptor);
  });

  test("lookup returns undefined for unknown zone", async () => {
    const found = await registry.lookup(zoneId("nonexistent"));
    expect(found).toBeUndefined();
  });

  test("list returns all registered zones", async () => {
    await registry.register(createDescriptor("zone-a"));
    await registry.register(createDescriptor("zone-b"));

    const all = await registry.list();
    expect(all).toHaveLength(2);
  });

  test("list filters by status", async () => {
    await registry.register(createDescriptor("zone-a"));
    await registry.register({
      ...createDescriptor("zone-b"),
      status: "offline",
    });

    const active = await registry.list({ status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]?.zoneId).toBe(zoneId("zone-a"));
  });

  test("watch unsubscribe stops notifications", async () => {
    const events: ZoneEvent[] = [];
    const unsub = registry.watch((e) => {
      events.push(e);
    });

    await registry.register(createDescriptor("zone-a"));
    expect(events).toHaveLength(1);

    unsub();
    await registry.register(createDescriptor("zone-b"));
    expect(events).toHaveLength(1); // no new events
  });

  test("register throws on RPC error", async () => {
    const errorClient = createMockClient();
    errorClient.rpcMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Network error",
          retryable: false,
        } satisfies KoiError,
      } satisfies Result<unknown, KoiError>),
    );
    const errorRegistry = createZoneRegistryNexus({ client: errorClient });

    await expect(errorRegistry.register(createDescriptor("zone-a"))).rejects.toThrow(
      "Failed to register zone",
    );
  });

  test("deregister throws on RPC error", async () => {
    const errorClient = createMockClient();
    errorClient.rpcMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Network error",
          retryable: false,
        } satisfies KoiError,
      } satisfies Result<unknown, KoiError>),
    );
    const errorRegistry = createZoneRegistryNexus({ client: errorClient });

    await expect(errorRegistry.deregister(zoneId("zone-a"))).rejects.toThrow(
      "Failed to deregister zone",
    );
  });
});
