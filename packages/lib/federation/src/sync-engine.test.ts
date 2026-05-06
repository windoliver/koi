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

  test("dedupes identical events with duplicate sequences within a single batch", async () => {
    // Regression for #1372 review-loop round 4: a remote returning [1,1,2]
    // with identical payloads must deliver event 1 exactly once. Duplicate
    // side effects on a single sync cycle would defeat exactly-once
    // handler semantics.
    const e1 = evt(1);
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [e1, e1, evt(2)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received.map((e) => e.sequence)).toEqual([1, 2]);
    expect(engine.getEventLog("zone-b")).toHaveLength(2);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(2);
  });

  test("rejects batch as protocol fault when same sequence carries conflicting payloads", async () => {
    // Regression for #1372 review-loop round 5: silently collapsing
    // conflicting duplicates would mask remote corruption and let
    // different consumers accept different versions, causing silent
    // cross-zone divergence. Treat as protocol fault, do not advance.
    const dup1a = { ...evt(1), data: { tag: "first" } };
    const dup1b = { ...evt(1), data: { tag: "second" } };
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [dup1a, dup1b, evt(2)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 2,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received).toEqual([]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(0);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);

    await engine.sync();
    expect(engine.getHealth("zone-b")?.status).toBe("offline");
  });

  test("marks zone offline when remote keeps returning a non-contiguous batch", async () => {
    // Regression for #1372 review-loop round 3: a remote that keeps
    // returning [2,3] for cursor 0 stalls replication forever. The
    // engine must surface this as a failure (eventually offline) instead
    // of staying silently active with no forward progress.
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [evt(2), evt(3)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 2,
    });
    engines.push(engine);

    await engine.sync();
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(0);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);
    expect(engine.getHealth("zone-b")?.status).toBe("active");

    await engine.sync();
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(2);
    expect(engine.getHealth("zone-b")?.status).toBe("offline");
  });

  test("rejects entire batch on a gap; delivers everything on a corrected batch", async () => {
    // Wire-protocol v1: a batch like [1,2,4] is a protocol fault — the
    // engine must NOT deliver 1 or 2 partially and must NOT advance the
    // cursor. When the remote returns the clean batch [1..4], everything
    // is delivered exactly once.
    let mode: "gap" | "filled" = "gap";
    const client: SyncClient = {
      fetchDelta: async () => {
        const events = mode === "gap" ? [evt(1), evt(2), evt(4)] : [evt(1), evt(2), evt(3), evt(4)];
        return { ok: true, value: events };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received).toEqual([]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(0);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);

    mode = "filled";
    await engine.sync();
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(4);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(0);
  });

  test("permissive mode (strictV1=false) tolerates gapped batch by delivering safe prefix", async () => {
    // Regression for #1372 review-loop round 8: permissive mode exists
    // for rolling upgrades against pre-v1 peers. Same gapped batch [1,2,4]
    // → delivers 1,2 and advances cursor; failure counter unchanged.
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [evt(1), evt(2), evt(4)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
      strictV1: false,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received.map((e) => e.sequence)).toEqual([1, 2]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(2);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(0);
  });

  test("rejects reordered batch [2,1] as a protocol fault", async () => {
    // Wire-protocol v1: events must arrive in ascending sequence order.
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [evt(2), evt(1)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 2,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received).toEqual([]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(0);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);
  });

  test("rejects spoofed events whose originZoneId differs from queried remote", async () => {
    // Regression for #1372 review-loop: a remote claiming events from another
    // zone must be treated as a protocol fault, not silently delivered.
    const ZC = zoneId("zone-c");
    const spoofed: FederationSyncEvent = {
      kind: "test",
      originZoneId: ZC, // claims to be from zone-c, but we queried zone-b
      sequence: 1,
      data: {},
      emittedAt: 1,
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", fakeClient({ events: [spoofed] })]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 2,
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received).toEqual([]);
    // Cursor must NOT advance on a spoofed batch.
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(0);
    // Counted as a protocol failure.
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);

    await engine.sync();
    expect(engine.getHealth("zone-b")?.status).toBe("offline");
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
