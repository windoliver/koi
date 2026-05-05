import { describe, expect, test } from "bun:test";
import type { KoiError, Result, ZoneDescriptor, ZoneEvent } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createZoneRegistryNexus } from "./zone-registry-nexus.js";

const ZA = zoneId("zone-a");

function makeDescriptor(id: string = "zone-a"): ZoneDescriptor {
  return {
    zoneId: zoneId(id),
    displayName: id,
    status: "active",
    metadata: { region: "us-east" },
    registeredAt: 1_000,
  };
}

interface CallRecord {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function makeTransport(handler: (method: string) => unknown): {
  transport: NexusTransport;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const callImpl = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> => {
    calls.push({ method, params });
    const value = handler(method);
    if (value instanceof Error) {
      const err: KoiError = { code: "EXTERNAL", message: value.message, retryable: true };
      return { ok: false, error: err };
    }
    return { ok: true, value: value as T };
  };
  return { transport: { call: callImpl, close: () => {} }, calls };
}

describe("createZoneRegistryNexus", () => {
  test("register stores descriptor in projection and emits event", async () => {
    const desc = makeDescriptor();
    const events: ZoneEvent[] = [];
    const { transport, calls } = makeTransport(() => desc);
    const registry = createZoneRegistryNexus({ transport });
    registry.watch((e) => events.push(e));

    const stored = await registry.register(desc);
    expect(stored).toEqual(desc);
    expect(calls[0]?.method).toBe("federation.zone_register");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("zone_registered");
    expect(await registry.lookup(ZA)).toEqual(desc);

    await registry[Symbol.asyncDispose]();
  });

  test("register throws on transport error", async () => {
    const { transport } = makeTransport(() => new Error("nexus down"));
    const registry = createZoneRegistryNexus({ transport });
    await expect(registry.register(makeDescriptor())).rejects.toThrow(/Failed to register zone/);
    await registry[Symbol.asyncDispose]();
  });

  test("deregister removes from projection and emits event when server confirms", async () => {
    const desc = makeDescriptor();
    const events: ZoneEvent[] = [];
    const { transport, calls } = makeTransport((method) => {
      if (method === "federation.zone_register") return desc;
      return true;
    });
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(desc);
    registry.watch((e) => events.push(e));

    const ok = await registry.deregister(ZA);
    expect(ok).toBe(true);
    expect(calls.map((c) => c.method)).toContain("federation.zone_deregister");
    expect(await registry.lookup(ZA)).toBeUndefined();
    expect(events.find((e) => e.kind === "zone_deregistered")).toBeDefined();

    await registry[Symbol.asyncDispose]();
  });

  test("list applies filter by status", async () => {
    const a: ZoneDescriptor = { ...makeDescriptor("a"), status: "active" };
    const b: ZoneDescriptor = { ...makeDescriptor("b"), status: "draining" };
    let next: ZoneDescriptor = a;
    const { transport } = makeTransport(() => next);
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(a);
    next = b;
    await registry.register(b);

    const active = await registry.list({ status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]?.zoneId).toBe(zoneId("a"));

    const all = await registry.list();
    expect(all).toHaveLength(2);

    await registry[Symbol.asyncDispose]();
  });

  test("watch returns unsubscribe function", async () => {
    const desc = makeDescriptor();
    const events: ZoneEvent[] = [];
    const { transport } = makeTransport(() => desc);
    const registry = createZoneRegistryNexus({ transport });
    const unsub = registry.watch((e) => events.push(e));
    unsub();

    await registry.register(desc);
    expect(events).toHaveLength(0);

    await registry[Symbol.asyncDispose]();
  });

  test("dispose clears projection and listeners", async () => {
    const desc = makeDescriptor();
    const { transport } = makeTransport(() => desc);
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(desc);
    await registry[Symbol.asyncDispose]();
    expect(await registry.lookup(ZA)).toBeUndefined();
    expect(await registry.list()).toEqual([]);
  });
});
