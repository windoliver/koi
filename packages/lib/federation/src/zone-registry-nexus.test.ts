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

/** Build a transport whose response varies per method. */
function makeMethodTransport(handlers: Record<string, () => unknown>): {
  transport: NexusTransport;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const callImpl = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (handler === undefined) {
      // Mirror a Nexus hub that hasn't implemented the method: surfaces
      // the JSON-RPC -32601 phrasing the auto-downgrade heuristic looks
      // for. Tests that want a different failure mode register a
      // handler that throws with their preferred error.
      const err: KoiError = {
        code: "EXTERNAL",
        message: `Method not found: ${method}`,
        retryable: false,
      };
      return { ok: false, error: err };
    }
    const value = handler();
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
    const { transport, calls } = makeMethodTransport({
      "federation.zone_register": () => desc,
    });
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
    const { transport, calls } = makeMethodTransport({
      "federation.zone_register": () => desc,
      "federation.zone_deregister": () => true,
      "federation.zone_lookup": () => null,
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

  test("deregister fails closed when server returns non-boolean payload", async () => {
    // Regression for #1372 review-loop pass-3 round 1: a malformed
    // success payload must not be interpreted as confirmation.
    const desc = makeDescriptor();
    const { transport } = makeMethodTransport({
      "federation.zone_register": () => desc,
      "federation.zone_deregister": () => ({ status: "ok" }) as unknown,
    });
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(desc);
    await expect(registry.deregister(ZA)).rejects.toThrow(/non-boolean payload/);
    await registry[Symbol.asyncDispose]();
  });

  test("list (useServerReads) returns hub-authoritative results", async () => {
    const a: ZoneDescriptor = { ...makeDescriptor("a"), status: "active" };
    const b: ZoneDescriptor = { ...makeDescriptor("b"), status: "draining" };
    const { transport } = makeMethodTransport({
      "federation.zone_list": () => [a, b],
    });
    const registry = createZoneRegistryNexus({ transport, useServerReads: true });

    const active = await registry.list({ status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]?.zoneId).toBe(zoneId("a"));

    const all = await registry.list();
    expect(all).toHaveLength(2);

    await registry[Symbol.asyncDispose]();
  });

  test("list (auto default) downgrades to projection when hub lacks zone_list", async () => {
    // Regression for #1372 review-loop pass-3 round 10: default mode
    // tries the hub first so fresh processes can discover peers, but
    // gracefully falls back to the writer-local projection when the
    // hub returns method-not-found. The fallback is sticky for the
    // registry's lifetime so we don't pay the failed-RPC cost again.
    const a: ZoneDescriptor = { ...makeDescriptor("a"), status: "active" };
    const b: ZoneDescriptor = { ...makeDescriptor("b"), status: "draining" };
    let next: ZoneDescriptor = a;
    const { transport, calls } = makeMethodTransport({
      "federation.zone_register": () => next,
      // No zone_list handler → makeMethodTransport returns
      // "Method not found", triggering the auto-downgrade.
    });
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(a);
    next = b;
    await registry.register(b);

    const all = await registry.list();
    expect(all).toHaveLength(2);
    expect(calls.find((c) => c.method === "federation.zone_list")).toBeDefined();

    // Second list call should NOT re-issue the failed RPC.
    const before = calls.filter((c) => c.method === "federation.zone_list").length;
    await registry.list();
    expect(calls.filter((c) => c.method === "federation.zone_list").length).toBe(before);
    await registry[Symbol.asyncDispose]();
  });

  test("list (always) propagates method-not-found as a hard error", async () => {
    const { transport } = makeMethodTransport({});
    const registry = createZoneRegistryNexus({ transport, serverReadsMode: "always" });
    await expect(registry.list()).rejects.toThrow(/Method not found/);
    await registry[Symbol.asyncDispose]();
  });

  test("lookup (useServerReads) sources from Nexus, not local projection", async () => {
    // Regression for #1372 review-loop pass-3 round 1: a process that
    // never personally registered a zone must still discover it via
    // the hub. Opt-in flag enables zone_lookup RPC against hubs that
    // have implemented the read handlers.
    const peerDesc = makeDescriptor("peer-zone");
    const { transport, calls } = makeMethodTransport({
      "federation.zone_lookup": () => peerDesc,
    });
    const registry = createZoneRegistryNexus({ transport, useServerReads: true });
    const found = await registry.lookup(zoneId("peer-zone"));
    expect(found?.zoneId).toBe(zoneId("peer-zone"));
    expect(calls[0]?.method).toBe("federation.zone_lookup");
    await registry[Symbol.asyncDispose]();
  });

  test("lookup (useServerReads) throws when server returns non-descriptor payload", async () => {
    const { transport } = makeMethodTransport({
      "federation.zone_lookup": () => ({ junk: 1 }) as unknown,
    });
    const registry = createZoneRegistryNexus({ transport, useServerReads: true });
    await expect(registry.lookup(ZA)).rejects.toThrow(/not a ZoneDescriptor/);
    await registry[Symbol.asyncDispose]();
  });

  test("lookup (auto default) tries hub first, downgrades on method-not-found, reuses projection thereafter", async () => {
    // Regression for #1372 review-loop pass-3 round 10: default mode
    // is "auto" — try zone_lookup first so a fresh process can discover
    // peers, fall back to projection if the hub doesn't implement it,
    // and remember the downgrade so subsequent lookups skip the RPC.
    const desc = makeDescriptor();
    const { transport, calls } = makeMethodTransport({
      "federation.zone_register": () => desc,
    });
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(desc);

    // First lookup: server attempted, method-not-found, downgrades.
    expect(await registry.lookup(ZA)).toEqual(desc);
    expect(calls.filter((c) => c.method === "federation.zone_lookup")).toHaveLength(1);

    // Subsequent lookups: must NOT re-issue the RPC.
    expect(await registry.lookup(ZA)).toEqual(desc);
    expect(calls.filter((c) => c.method === "federation.zone_lookup")).toHaveLength(1);

    await registry[Symbol.asyncDispose]();
  });

  test("lookup (auto default) propagates non-method-not-found errors instead of downgrading", async () => {
    // Transient network errors must NOT permanently downgrade the
    // registry — only signals that the method genuinely doesn't exist.
    const { transport } = makeMethodTransport({
      "federation.zone_lookup": () => new Error("connection refused"),
    });
    const registry = createZoneRegistryNexus({ transport });
    await expect(registry.lookup(ZA)).rejects.toThrow(/connection refused/);
    await registry[Symbol.asyncDispose]();
  });

  test("watch returns unsubscribe function", async () => {
    const desc = makeDescriptor();
    const events: ZoneEvent[] = [];
    const { transport } = makeMethodTransport({
      "federation.zone_register": () => desc,
    });
    const registry = createZoneRegistryNexus({ transport });
    const unsub = registry.watch((e) => events.push(e));
    unsub();

    await registry.register(desc);
    expect(events).toHaveLength(0);

    await registry[Symbol.asyncDispose]();
  });

  test("dispose clears the local projection (default mode reads return empty)", async () => {
    const desc = makeDescriptor();
    const { transport } = makeMethodTransport({
      "federation.zone_register": () => desc,
    });
    const registry = createZoneRegistryNexus({ transport });
    await registry.register(desc);
    await registry[Symbol.asyncDispose]();
    expect(await registry.lookup(ZA)).toBeUndefined();
    expect(await registry.list()).toEqual([]);
  });
});
