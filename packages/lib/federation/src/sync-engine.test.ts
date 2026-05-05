import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { zoneId } from "@koi/core";
import type { SyncEngineHandle } from "./sync-engine.js";
import { createSyncEngine } from "./sync-engine.js";
import type { SyncClient } from "./sync-protocol.js";
import type { FederationSyncEvent } from "./types.js";

const ZA = zoneId("zone-a");
const ZB = zoneId("zone-b");

function evt(seq: number): FederationSyncEvent {
  return {
    kind: "test",
    originZoneId: ZB,
    sequence: seq,
    data: { n: seq },
    emittedAt: 1_000 + seq,
  };
}

function fakeClient(opts: {
  readonly events?: readonly FederationSyncEvent[];
  readonly fail?: boolean;
}): SyncClient {
  return {
    fetchDelta: async () => {
      if (opts.fail === true) {
        const err: KoiError = { code: "EXTERNAL", message: "down", retryable: true };
        const r: Result<readonly FederationSyncEvent[], KoiError> = { ok: false, error: err };
        return r;
      }
      const r: Result<readonly FederationSyncEvent[], KoiError> = {
        ok: true,
        value: opts.events ?? [],
      };
      return r;
    },
    publishEvents: async () => ({ ok: true, value: undefined }),
  };
}

describe("createSyncEngine", () => {
  let engines: SyncEngineHandle[] = [];

  beforeEach(() => {
    engines = [];
  });

  afterEach(async () => {
    for (const e of engines) {
      await e[Symbol.asyncDispose]();
    }
  });

  test("manual sync delivers events to onEvent handlers and advances cursor", async () => {
    const events = [evt(1), evt(2), evt(3)];
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", fakeClient({ events })]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(3);
    expect(engine.getEventLog("zone-b")).toHaveLength(3);
  });

  test("deduplicates events across multiple sync cycles", async () => {
    const client = fakeClient({ events: [evt(1), evt(2)] });
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    await engine.sync(); // same payload; nothing new
    expect(received).toHaveLength(2);
  });

  test("health monitor marks zone offline after N consecutive failures", async () => {
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", fakeClient({ fail: true })]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 2,
    });
    engines.push(engine);

    expect(engine.getHealth("zone-b")?.status).toBe("active");
    await engine.sync();
    expect(engine.getHealth("zone-b")?.status).toBe("active");
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);
    await engine.sync();
    expect(engine.getHealth("zone-b")?.status).toBe("offline");
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(2);
  });

  test("health restored after a successful fetch", async () => {
    let mode: "fail" | "ok" = "fail";
    const client: SyncClient = {
      fetchDelta: async () => {
        if (mode === "fail") {
          const err: KoiError = { code: "EXTERNAL", message: "x", retryable: true };
          return { ok: false, error: err };
        }
        return { ok: true, value: [evt(1)] };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 1,
    });
    engines.push(engine);

    await engine.sync();
    expect(engine.getHealth("zone-b")?.status).toBe("offline");
    mode = "ok";
    await engine.sync();
    expect(engine.getHealth("zone-b")?.status).toBe("active");
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(0);
  });

  test("dispose clears timer and prevents further events", async () => {
    const client = fakeClient({ events: [evt(1)] });
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
    });
    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));
    await engine[Symbol.asyncDispose]();

    // After dispose, sync should be a no-op
    await engine.sync();
    expect(received).toHaveLength(0);
  });
});
