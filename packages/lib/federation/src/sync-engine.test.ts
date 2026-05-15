import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { zoneId } from "@koi/core";
import type { SyncEngineHandle } from "./sync-engine.js";
import { createSyncEngine } from "./sync-engine.js";
import type { SyncClient } from "./sync-protocol.js";
import type { FederationSyncEvent, ReportedConflict, SyncCursor } from "./types.js";

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

  test("hung remote does not block syncs on healthy peers; eventually counts toward offline", async () => {
    // Regression for #1372 review-loop pass-2 round 1: a remote whose
    // fetchDelta never resolves must NOT freeze replication for other
    // zones. Per-zone fetch timeout converts the hang into a counted
    // failure for the hung zone alone.
    const hungClient: SyncClient = {
      fetchDelta: () => new Promise(() => {}), // never resolves
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const okEvent: FederationSyncEvent = {
      kind: "test",
      originZoneId: zoneId("zone-ok"),
      sequence: 1,
      data: {},
      emittedAt: 1,
    };
    const okClient: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [okEvent] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([
        ["zone-hung", hungClient],
        ["zone-ok", okClient],
      ]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 1,
      fetchTimeoutMs: 30, // tight timeout so the test is fast
    });
    engines.push(engine);

    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(received).toHaveLength(1);
    // Healthy peer made progress.
    expect(engine.getCursor("zone-ok")?.lastSequence).toBe(1);
    // Hung peer was timed out and counted toward offline.
    expect(engine.getHealth("zone-hung")?.status).toBe("offline");
  });

  test("event log is bounded when cap configured; truncated count is exposed", async () => {
    // Regression for #1372 review-loop pass-2 rounds 1-2: replicated
    // event logs grow unbounded by default. Opting in to a finite
    // eventLogMaxPerZone drops oldest events AND records the dropped
    // count via getTruncatedCount() so callers can detect the gap.
    let next = 1;
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [evt(next++)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
      eventLogMaxPerZone: 2,
    });
    engines.push(engine);

    await engine.sync(); // seq 1
    await engine.sync(); // seq 2
    await engine.sync(); // seq 3 — evicts 1
    await engine.sync(); // seq 4 — evicts 2

    const log = engine.getEventLog("zone-b");
    expect(log.map((e) => e.sequence)).toEqual([3, 4]);
    expect(engine.getTruncatedCount("zone-b")).toBe(2);
  });

  test("default event log is unbounded; truncated count stays at 0", async () => {
    // Regression for #1372 review-loop pass-2 round 2: default behavior
    // must NOT silently destroy history. Opt-in only.
    let next = 1;
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [evt(next++)] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
      // eventLogMaxPerZone NOT set → unbounded
    });
    engines.push(engine);

    for (let i = 0; i < 10; i++) await engine.sync();

    expect(engine.getEventLog("zone-b")).toHaveLength(10);
    expect(engine.getTruncatedCount("zone-b")).toBe(0);
  });

  test("rejects config where outstandingFetchMaxAgeMs < fetchTimeoutMs (would reintroduce overlap)", () => {
    // Regression for #1372 review-loop pass-2 round 6: a misconfig
    // where outstandingFetchMaxAgeMs is shorter than fetchTimeoutMs
    // would evict outstanding entries before the original times out,
    // reintroducing overlapping RPCs. Must fail-fast at construction.
    expect(() =>
      createSyncEngine({
        localZoneId: ZA,
        remoteClients: new Map(),
        pollIntervalMs: 60_000,
        offlineAfterFailures: 3,
        fetchTimeoutMs: 1000,
        outstandingFetchMaxAgeMs: 500, // < fetchTimeoutMs
      }),
    ).toThrow(/outstandingFetchMaxAgeMs.*must be >= fetchTimeoutMs/);
  });

  test("rejects non-positive fetchTimeoutMs", () => {
    expect(() =>
      createSyncEngine({
        localZoneId: ZA,
        remoteClients: new Map(),
        pollIntervalMs: 60_000,
        offlineAfterFailures: 3,
        fetchTimeoutMs: 0,
      }),
    ).toThrow(/fetchTimeoutMs/);
    expect(() =>
      createSyncEngine({
        localZoneId: ZA,
        remoteClients: new Map(),
        pollIntervalMs: 60_000,
        offlineAfterFailures: 3,
        fetchTimeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/fetchTimeoutMs/);
  });

  test("rejects unsupported conflictResolution at construction", () => {
    expect(() =>
      createSyncEngine({
        localZoneId: ZA,
        remoteClients: new Map([["zone-b", fakeClient({ events: [] })]]),
        pollIntervalMs: 60_000,
        offlineAfterFailures: 3,
        // @ts-expect-error exercising runtime validation for malformed JS callers
        conflictResolution: "newest",
      }),
    ).toThrow(/conflictResolution must be one of/);
  });

  test("stale outstanding fetch beyond outstandingFetchMaxAgeMs marks zone offline (no replacement RPC)", async () => {
    // Regression for #1372 review-loop pass-2 rounds 3+5+7: a leaked
    // never-settling fetch must NOT trigger a replacement RPC (would
    // overlap with the original on the remote since SyncClient has no
    // cancel hook in v1). Instead, the zone is marked offline so no
    // further fetches dispatch until something else clears state
    // (process restart, future sync_fetch_delta capability with
    // server-side fetchId dedup — #1410).
    let fetchCalls = 0;
    const client: SyncClient = {
      fetchDelta: async () => {
        fetchCalls++;
        await new Promise<void>(() => {}); // never settles
        return { ok: true, value: [] };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
      fetchTimeoutMs: 10,
      outstandingFetchMaxAgeMs: 30,
    });
    engines.push(engine);

    await engine.sync(); // first call hangs
    expect(fetchCalls).toBe(1);

    await engine.sync(); // young outstanding — skip
    expect(fetchCalls).toBe(1);

    await new Promise((r) => setTimeout(r, 50));

    await engine.sync(); // stale outstanding → mark offline, do NOT dispatch
    expect(fetchCalls).toBe(1);
    expect(engine.getHealth("zone-b")?.status).toBe("offline");

    // Subsequent syncs against an offline zone are still no-ops.
    await engine.sync();
    expect(fetchCalls).toBe(1);
  });

  test("eventual settlement of leaked fetch clears slot, allowing recovery on next sync", async () => {
    // Regression for #1372 review-loop pass-2 round 7: a leaked fetch
    // marks the zone offline, but if it eventually does settle, the
    // tokenized .finally must release the slot so a fresh fetch can
    // run on the next sync (recovery path without overlap risk).
    let fetchCalls = 0;
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const client: SyncClient = {
      fetchDelta: async () => {
        fetchCalls++;
        if (fetchCalls === 1) {
          await new Promise<void>((res) => {
            resolveA = res;
          });
          return { ok: true, value: [] };
        }
        await new Promise<void>((res) => {
          resolveB = res;
        });
        return { ok: true, value: [] };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 5,
      fetchTimeoutMs: 10,
      outstandingFetchMaxAgeMs: 30,
    });
    engines.push(engine);

    await engine.sync(); // A times out, slot held
    expect(fetchCalls).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    await engine.sync(); // stale → offline, slot kept, no replacement
    expect(fetchCalls).toBe(1);
    expect(engine.getHealth("zone-b")?.status).toBe("offline");

    // A eventually settles — its tokenized .finally clears the slot.
    resolveA?.();
    await new Promise((r) => setTimeout(r, 5));

    await engine.sync(); // slot cleared → fresh fetch B dispatched
    expect(fetchCalls).toBe(2);

    resolveB?.();
  });

  test("hung remote does not stack overlapping fetchDelta calls across sync cycles", async () => {
    // Regression for #1372 review-loop pass-2 round 2: a timed-out
    // fetchDelta is abandoned locally but still runs remotely. The
    // engine must NOT launch another fetchDelta on the next sync cycle
    // until the prior one settles, otherwise concurrent RPCs accumulate
    // unboundedly against a degraded peer.
    let fetchCalls = 0;
    let releaseFirst: (() => void) | undefined;
    const client: SyncClient = {
      fetchDelta: async () => {
        fetchCalls++;
        // Hold the first call open until we explicitly release it.
        await new Promise<void>((res) => {
          releaseFirst = res;
        });
        return { ok: true, value: [] };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 999,
      fetchTimeoutMs: 20,
    });
    engines.push(engine);

    await engine.sync(); // first call: hangs, times out
    expect(fetchCalls).toBe(1);

    await engine.sync(); // would-be second call: must SKIP because outstanding
    expect(fetchCalls).toBe(1);

    // Release and let it settle so the engine can sync again.
    releaseFirst?.();
    // Wait one microtask tick for the cleanup to run.
    await new Promise((r) => setTimeout(r, 5));

    await engine.sync();
    expect(fetchCalls).toBe(2);
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

  test("initialCursors rejects unknown zones, mismatched zoneId, and non-finite/negative values", () => {
    // Regression for #1372 review-loop pass-4 round 6: a stale or
    // corrupt persisted cursor would otherwise silently skip replay
    // (dedup drops everything, empty post-dedup batch resets health
    // to active). Fail closed at construction so bad durable state
    // is loud, not silent.
    const client: SyncClient = {
      fetchDelta: async () => ({ ok: true, value: [] }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const remotes = new Map([["zone-b", client]]);
    const base = {
      localZoneId: ZA,
      remoteClients: remotes,
      pollIntervalMs: 1000,
      offlineAfterFailures: 3,
    } as const;

    expect(() =>
      createSyncEngine({
        ...base,
        initialCursors: new Map([
          ["zone-ghost", { zoneId: zoneId("zone-ghost"), lastSequence: 0, lastSyncAt: 0 }],
        ]),
      }),
    ).toThrow(/not in remoteClients/);

    expect(() =>
      createSyncEngine({
        ...base,
        initialCursors: new Map([
          ["zone-b", { zoneId: zoneId("zone-other"), lastSequence: 0, lastSyncAt: 0 }],
        ]),
      }),
    ).toThrow(/must equal the map key/);

    expect(() =>
      createSyncEngine({
        ...base,
        initialCursors: new Map([
          ["zone-b", { zoneId: zoneId("zone-b"), lastSequence: -1, lastSyncAt: 0 }],
        ]),
      }),
    ).toThrow(/non-negative integer/);

    expect(() =>
      createSyncEngine({
        ...base,
        initialCursors: new Map([
          ["zone-b", { zoneId: zoneId("zone-b"), lastSequence: Number.NaN, lastSyncAt: 0 }],
        ]),
      }),
    ).toThrow(/non-negative integer/);

    expect(() =>
      createSyncEngine({
        ...base,
        initialCursors: new Map([
          [
            "zone-b",
            {
              zoneId: zoneId("zone-b"),
              vectorClock: { "zone-b": -1 },
              lastSequence: 0,
              lastSyncAt: 0,
            },
          ],
        ]),
      }),
    ).toThrow(/vectorClock/);

    expect(() =>
      createSyncEngine({
        ...base,
        initialCursors: new Map([
          [
            "zone-b",
            { zoneId: zoneId("zone-b"), vectorClock: [1], lastSequence: 0, lastSyncAt: 0 },
          ],
        ]) as unknown as ReadonlyMap<string, SyncCursor>,
      }),
    ).toThrow(/vectorClock/);
  });

  test("handler exception keeps cursor at the last successfully-delivered event so the failed batch is redelivered", async () => {
    // Regression for #1372 review-loop pass-4 round 10: previously the
    // cursor advanced past every event in the batch even when a
    // subscriber threw, causing silent data loss. Now the cursor
    // stops at the failed event and the next sync redelivers it.
    const events = [evt(1), evt(2), evt(3)];
    let attempt = 0;
    const client: SyncClient = {
      fetchDelta: async (cursor) => {
        attempt += 1;
        // First call: hub has [1,2,3]. Second call (after handler
        // recovers): hub has the same events; cursor should have
        // advanced only past the events the handler accepted.
        return { ok: true, value: events.filter((e) => e.sequence > cursor.lastSequence) };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 1_000_000,
      offlineAfterFailures: 100,
    });
    engines.push(engine);

    let throwOnSeq2 = true;
    const received: number[] = [];
    engine.onEvent((e) => {
      if (e.sequence === 2 && throwOnSeq2) {
        throw new Error("downstream write failed");
      }
      received.push(e.sequence);
    });

    await engine.sync();
    // Only seq 1 was delivered before the throw on seq 2.
    expect(received).toEqual([1]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(1);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(1);

    // Handler recovers, second sync redelivers seq 2 + seq 3.
    throwOnSeq2 = false;
    await engine.sync();
    expect(received).toEqual([1, 2, 3]);
    expect(engine.getCursor("zone-b")?.lastSequence).toBe(3);
    expect(engine.getHealth("zone-b")?.consecutiveFailures).toBe(0);
    expect(attempt).toBe(2);
  });

  test("dispose's zone_disconnect carries FEDERATION_PROTOCOL_VERSION on the wire", async () => {
    // Regression for #1372 review-loop pass-4 round 7: every other
    // federation RPC carries protocolVersion under the v1 contract.
    // Shutdown notifications must too, or strict/upgraded receivers
    // can reject them and leave the hub thinking the node is still
    // active until heartbeat expiry.
    const { FEDERATION_PROTOCOL_VERSION } = await import("./types.js");
    type Recorded = { method: string; params: Record<string, unknown> };
    const calls: Recorded[] = [];
    const callImpl = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      calls.push({ method, params });
      return { ok: true, value: undefined as T };
    };
    const hubTransport = { call: callImpl, close: () => {} };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map(),
      pollIntervalMs: 1_000_000,
      offlineAfterFailures: 3,
      hubTransport,
    });
    await engine[Symbol.asyncDispose]();
    const disconnect = calls.find((c) => c.method === "federation.zone_disconnect");
    expect(disconnect).toBeDefined();
    expect(disconnect?.params.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(disconnect?.params.zoneId).toBe(ZA);
  });

  test("initialCursors seeds replication progress so a restart does not replay history", async () => {
    // Regression for #1372 review-loop pass-4 round 4: process restarts
    // must not re-emit already-processed remote events. Callers persist
    // cursors via getCursor()/their own store and supply them back via
    // initialCursors at construction.
    const oldEvent: FederationSyncEvent = {
      kind: "test",
      originZoneId: zoneId("zone-b"),
      sequence: 5,
      data: { stale: true },
      emittedAt: 1,
    };
    const newEvent: FederationSyncEvent = {
      kind: "test",
      originZoneId: zoneId("zone-b"),
      sequence: 6,
      data: { fresh: true },
      emittedAt: 2,
    };
    const requestedSinces: number[] = [];
    const client: SyncClient = {
      fetchDelta: async (cursor) => {
        requestedSinces.push(cursor.lastSequence);
        // Hub returns whichever events follow the supplied cursor.
        const all = [oldEvent, newEvent];
        return { ok: true, value: all.filter((e) => e.sequence > cursor.lastSequence) };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 1_000_000,
      offlineAfterFailures: 3,
      initialCursors: new Map([
        ["zone-b", { zoneId: zoneId("zone-b"), lastSequence: 5, lastSyncAt: 999 }],
      ]),
    });
    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    await engine.sync();
    expect(requestedSinces).toEqual([5]);
    expect(received).toHaveLength(1);
    expect(received[0]?.sequence).toBe(6);
    await engine[Symbol.asyncDispose]();
  });

  test("forceResetZone clears a leaked outstanding fetch slot and restores active status", async () => {
    // Regression for #1372 review-loop pass-4: operator-visible recovery
    // path for a permanently-stuck fetch (e.g. crashed remote whose
    // fetchDelta promise will never settle). Without forceResetZone the
    // operator's only recovery is a process restart.
    let fetchCalls = 0;
    let release: (() => void) | undefined;
    const client: SyncClient = {
      fetchDelta: async () => {
        fetchCalls++;
        if (fetchCalls === 1) {
          await new Promise<void>((res) => {
            release = res;
          });
          return { ok: true, value: [] };
        }
        return { ok: true, value: [] };
      },
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 1,
      fetchTimeoutMs: 10,
      outstandingFetchMaxAgeMs: 1_000_000,
    });
    engines.push(engine);

    await engine.sync(); // first call hangs, times out → offline, slot held
    expect(fetchCalls).toBe(1);
    expect(engine.getHealth("zone-b")?.status).toBe("offline");

    await engine.sync(); // slot still held → SKIP
    expect(fetchCalls).toBe(1);

    // Operator force-resets — slot cleared, status restored.
    expect(engine.forceResetZone("zone-b")).toBe(true);
    expect(engine.getHealth("zone-b")?.status).toBe("active");

    await engine.sync(); // fresh fetch dispatched
    expect(fetchCalls).toBe(2);

    // Idempotent: returns false when no outstanding fetch exists.
    expect(engine.forceResetZone("zone-b")).toBe(false);

    release?.();
  });

  test("late-settling fetch after dispose does not mutate engine state", async () => {
    // Regression for #1372 review-loop pass-4: dispose() is terminal —
    // a fetch that resolves AFTER disposal must not deliver events,
    // advance cursors, or flip status. Without the post-await disposed
    // re-check, a slow successful response leaked memory and could
    // surface events to handlers that the caller already detached.
    let resolveFetch: ((v: { ok: true; value: FederationSyncEvent[] }) => void) | undefined;
    const client: SyncClient = {
      fetchDelta: () =>
        new Promise<{ ok: true; value: FederationSyncEvent[] }>((res) => {
          resolveFetch = res;
        }),
      publishEvents: async () => ({ ok: true, value: undefined }),
    };
    const engine = createSyncEngine({
      localZoneId: ZA,
      remoteClients: new Map([["zone-b", client]]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 999,
      fetchTimeoutMs: 1_000_000,
    });
    engines.push(engine);
    const received: FederationSyncEvent[] = [];
    engine.onEvent((e) => received.push(e));

    const syncPromise = engine.sync();
    // Allow fetchDelta to register before disposing.
    await new Promise((r) => setTimeout(r, 5));

    await engine[Symbol.asyncDispose]();

    // Settle the fetch AFTER dispose with a real event.
    resolveFetch?.({
      ok: true,
      value: [
        {
          originZoneId: zoneId("zone-b"),
          sequence: 1,
          kind: "agent.created",
          data: {},
          emittedAt: 1,
        },
      ],
    });
    await syncPromise;

    // Handler must NOT have received the late event; cursor must NOT
    // reflect the late event's sequence; status must NOT have been
    // touched. (getCursor may return undefined since no successful
    // delivery ever happened — either undefined or 0 is correct.)
    expect(received).toEqual([]);
    const cursor = engine.getCursor("zone-b");
    expect(cursor === undefined || cursor.lastSequence === 0).toBe(true);
  });

  test("reports concurrent shared-resource conflicts to subscribers", async () => {
    const zoneAEvent: FederationSyncEvent = {
      kind: "state.write",
      originZoneId: zoneId("zone-a"),
      sequence: 1,
      vectorClock: { "zone-a": 1 },
      data: { resourceKey: "shared-doc", left: true },
      emittedAt: 10,
    };
    const zoneCEvent: FederationSyncEvent = {
      kind: "state.write",
      originZoneId: zoneId("zone-c"),
      sequence: 1,
      vectorClock: { "zone-c": 1 },
      data: { resourceKey: "shared-doc", right: true },
      emittedAt: 20,
    };
    const engine = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([
        ["zone-a", fakeClient({ events: [zoneAEvent] })],
        ["zone-c", fakeClient({ events: [zoneCEvent] })],
      ]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
      conflictResolution: "lww",
    });
    engines.push(engine);

    const conflicts: ReportedConflict[] = [];
    engine.onConflict((report) => conflicts.push(report));

    await engine.sync();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.resourceKey).toBe("shared-doc");
    expect(conflicts[0]?.resolution.kind).toBe("resolved");
    if (conflicts[0]?.resolution.kind === "resolved") {
      expect(conflicts[0].resolution.event).toBe(zoneCEvent);
    }
    expect(engine.getConflictReports()).toHaveLength(1);
  });

  test("reports merge conflict resolution through UI hook", async () => {
    const zoneAEvent: FederationSyncEvent = {
      kind: "state.write",
      originZoneId: zoneId("zone-a"),
      sequence: 1,
      vectorClock: { "zone-a": 1 },
      data: { resourceKey: "shared-doc", left: true },
      emittedAt: 10,
    };
    const zoneCEvent: FederationSyncEvent = {
      kind: "state.write",
      originZoneId: zoneId("zone-c"),
      sequence: 1,
      vectorClock: { "zone-c": 1 },
      data: { resourceKey: "shared-doc", right: true },
      emittedAt: 20,
    };
    const engine = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([
        ["zone-a", fakeClient({ events: [zoneAEvent] })],
        ["zone-c", fakeClient({ events: [zoneCEvent] })],
      ]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
      conflictResolution: "merge",
    });
    engines.push(engine);

    const conflicts: ReportedConflict[] = [];
    engine.onConflict((report) => conflicts.push(report));

    await engine.sync();

    expect(conflicts[0]?.resolution.kind).toBe("resolved");
    if (conflicts[0]?.resolution.kind === "resolved") {
      expect(conflicts[0].resolution.strategy).toBe("merge");
      expect(conflicts[0].resolution.event.data).toEqual({
        resourceKey: "shared-doc",
        left: true,
        right: true,
      });
    }
  });

  test("reports manual conflict resolution through UI hook", async () => {
    const zoneAEvent: FederationSyncEvent = {
      kind: "state.write",
      originZoneId: zoneId("zone-a"),
      sequence: 1,
      vectorClock: { "zone-a": 1 },
      data: { resourceKey: "shared-doc", left: true },
      emittedAt: 10,
    };
    const zoneCEvent: FederationSyncEvent = {
      kind: "state.write",
      originZoneId: zoneId("zone-c"),
      sequence: 1,
      vectorClock: { "zone-c": 1 },
      data: { resourceKey: "shared-doc", right: true },
      emittedAt: 20,
    };
    const engine = createSyncEngine({
      localZoneId: ZB,
      remoteClients: new Map([
        ["zone-a", fakeClient({ events: [zoneAEvent] })],
        ["zone-c", fakeClient({ events: [zoneCEvent] })],
      ]),
      pollIntervalMs: 60_000,
      offlineAfterFailures: 3,
      conflictResolution: "manual",
    });
    engines.push(engine);

    const conflicts: ReportedConflict[] = [];
    engine.onConflict((report) => conflicts.push(report));

    await engine.sync();

    expect(conflicts[0]?.resolution.kind).toBe("manual");
    if (conflicts[0]?.resolution.kind === "manual") {
      expect(conflicts[0].resolution.report.resourceKey).toBe("shared-doc");
    }
  });
});
