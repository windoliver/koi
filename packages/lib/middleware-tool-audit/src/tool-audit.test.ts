import { describe, expect, mock, test } from "bun:test";
import type { SessionContext, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";
import type { ToolAuditConfig } from "./config.js";
import { createToolAuditMiddleware } from "./tool-audit.js";
import type { ToolAuditMiddleware, ToolAuditSnapshot, ToolAuditStore } from "./types.js";

function sessionCtx(opts: { readonly sessionId?: string } = {}): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sessionId(opts.sessionId ?? "sess-1"),
    runId: runId("run-1"),
    metadata: {},
  };
}

function turnCtx(session?: SessionContext): TurnContext {
  const rid = runId("run-1");
  return {
    session: session ?? sessionCtx(),
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function toolReq(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

function modelReqWithTools(toolNames: readonly string[]): ModelRequest {
  return {
    messages: [],
    tools: toolNames.map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: {},
    })),
  };
}

function modelReqNoTools(): ModelRequest {
  return { messages: [] };
}

function modelResponse(): ModelResponse {
  return { content: "ok", model: "test" };
}

function createMockStore(initial?: ToolAuditSnapshot): {
  readonly store: ToolAuditStore;
  readonly saves: ToolAuditSnapshot[];
} {
  const saves: ToolAuditSnapshot[] = [];
  const stored = initial ?? { tools: {}, totalSessions: 0, lastUpdatedAt: 0 };
  return {
    store: {
      load: () => stored,
      save: (snapshot) => {
        saves.push(snapshot);
      },
    },
    saves,
  };
}

function getWrapToolCall(
  mw: ToolAuditMiddleware,
): (ctx: TurnContext, request: ToolRequest, next: ToolHandler) => Promise<ToolResponse> {
  const wrap = mw.wrapToolCall;
  if (!wrap) throw new Error("wrapToolCall is not defined");
  return wrap;
}

function getWrapModelCall(
  mw: ToolAuditMiddleware,
): (ctx: TurnContext, request: ModelRequest, next: ModelHandler) => Promise<ModelResponse> {
  const wrap = mw.wrapModelCall;
  if (!wrap) throw new Error("wrapModelCall is not defined");
  return wrap;
}

// let: incremented by fakeClock callers
let clockValue = 1000;
function fakeClock(): number {
  return clockValue;
}

function defaultConfig(overrides?: Partial<ToolAuditConfig>): ToolAuditConfig {
  clockValue = 1000;
  return { clock: fakeClock, ...overrides };
}

describe("createToolAuditMiddleware", () => {
  test("has correct name, priority, and observe phase", () => {
    const mw = createToolAuditMiddleware(defaultConfig());
    expect(mw.name).toBe("koi:tool-audit");
    expect(mw.priority).toBe(100);
    expect(mw.phase).toBe("observe");
  });

  test("describeCapabilities returns tool-audit fragment", () => {
    const mw = createToolAuditMiddleware(defaultConfig());
    const result = mw.describeCapabilities(turnCtx());
    expect(result?.label).toBe("tool-audit");
    expect(result?.description).toContain("Tool usage tracking");
  });

  test("throws KoiRuntimeError on invalid config — round 24 F2", async () => {
    const { KoiRuntimeError } = await import("@koi/errors");
    expect(() => createToolAuditMiddleware({ clock: true } as never)).toThrow(KoiRuntimeError);
    expect(() => createToolAuditMiddleware({ store: {} } as never)).toThrow(KoiRuntimeError);
    expect(() => createToolAuditMiddleware({ onAuditResult: 42 } as never)).toThrow(
      KoiRuntimeError,
    );
  });

  describe("wrapToolCall", () => {
    test("records success: counter increments and latency tracked", async () => {
      // let: simulates time passing during tool execution
      let time = 1000;
      const mw = createToolAuditMiddleware(defaultConfig({ clock: () => time }));
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      const next: ToolHandler = async () => {
        time += 50;
        return { output: "ok" };
      };

      await wrap(turnCtx(), toolReq("search"), next);

      const snapshot = mw.getSnapshot();
      const record = snapshot.tools.search;
      expect(record).toBeDefined();
      expect(record?.callCount).toBe(1);
      expect(record?.successCount).toBe(1);
      expect(record?.failureCount).toBe(0);
      expect(record?.minLatencyMs).toBe(50);
      expect(record?.maxLatencyMs).toBe(50);
      expect(record?.avgLatencyMs).toBe(50);
    });

    test("records failure: failure counter increments and error re-thrown", async () => {
      // let: simulates time passing
      let time = 1000;
      const mw = createToolAuditMiddleware(defaultConfig({ clock: () => time }));
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      const failingNext: ToolHandler = async () => {
        time += 30;
        throw new Error("tool broke");
      };

      await expect(wrap(turnCtx(), toolReq("search"), failingNext)).rejects.toThrow("tool broke");

      const snapshot = mw.getSnapshot();
      const record = snapshot.tools.search;
      expect(record?.callCount).toBe(1);
      expect(record?.successCount).toBe(0);
      expect(record?.failureCount).toBe(1);
      expect(record?.minLatencyMs).toBe(30);
    });

    test("latency tracks avg, min, and max across multiple calls", async () => {
      const latencies = [10, 50, 30];
      // let: index into latencies array
      let callIndex = 0;
      // let: simulates time
      let time = 1000;

      const mw = createToolAuditMiddleware(defaultConfig({ clock: () => time }));
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      const next: ToolHandler = async () => {
        time += latencies[callIndex] ?? 0;
        callIndex += 1;
        return { output: "ok" };
      };

      const ctx = turnCtx();
      await wrap(ctx, toolReq("search"), next);
      await wrap(ctx, toolReq("search"), next);
      await wrap(ctx, toolReq("search"), next);

      const snapshot = mw.getSnapshot();
      const record = snapshot.tools.search;
      expect(record?.callCount).toBe(3);
      expect(record?.minLatencyMs).toBe(10);
      expect(record?.maxLatencyMs).toBe(50);
      expect(record?.avgLatencyMs).toBe(30);
    });
  });

  describe("wrapModelCall", () => {
    test("tracks tool availability from request.tools", async () => {
      const mw = createToolAuditMiddleware(defaultConfig());
      const wrapModel = getWrapModelCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      await wrapModel(turnCtx(), modelReqWithTools(["search", "read"]), async () =>
        modelResponse(),
      );

      await mw.onSessionEnd?.(sessionCtx());

      const snapshot = mw.getSnapshot();
      expect(snapshot.tools.search?.sessionsAvailable).toBe(1);
      expect(snapshot.tools.read?.sessionsAvailable).toBe(1);
    });

    test("handles request.tools undefined gracefully", async () => {
      const mw = createToolAuditMiddleware(defaultConfig());
      const wrapModel = getWrapModelCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      const result = await wrapModel(turnCtx(), modelReqNoTools(), async () => modelResponse());
      expect(result.content).toBe("ok");
    });

    test("deduplicates tools across multiple model calls in same session", async () => {
      const mw = createToolAuditMiddleware(defaultConfig());
      const wrapModel = getWrapModelCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      await wrapModel(turnCtx(), modelReqWithTools(["search"]), async () => modelResponse());
      await wrapModel(turnCtx(), modelReqWithTools(["search"]), async () => modelResponse());

      await mw.onSessionEnd?.(sessionCtx());

      const snapshot = mw.getSnapshot();
      expect(snapshot.tools.search?.sessionsAvailable).toBe(1);
    });
  });

  describe("wrapModelStream", () => {
    test("tracks tool availability from request.tools on the streaming path", async () => {
      const mw = createToolAuditMiddleware(defaultConfig());
      const wrapStream = mw.wrapModelStream;
      if (!wrapStream) throw new Error("wrapModelStream is not defined");

      await mw.onSessionStart?.(sessionCtx());

      async function* emptyStream(): AsyncIterable<never> {
        // no chunks — exercise availability tracking only
      }
      const it = wrapStream(turnCtx(), modelReqWithTools(["search", "read"]), () => emptyStream());
      // Drain to honor the lazy-iterator contract.
      for await (const _ of it) {
        // intentionally empty
      }

      await mw.onSessionEnd?.(sessionCtx());

      const snapshot = mw.getSnapshot();
      expect(snapshot.tools.search?.sessionsAvailable).toBe(1);
      expect(snapshot.tools.read?.sessionsAvailable).toBe(1);
    });
  });

  describe("onSessionEnd", () => {
    test("fires onAuditResult callback with signals", async () => {
      const callback = mock((_results: readonly unknown[]) => {});
      const mw = createToolAuditMiddleware(
        defaultConfig({
          onAuditResult: callback,
          highValueMinCalls: 1,
          highValueSuccessThreshold: 0.9,
        }),
      );
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      expect(callback).toHaveBeenCalledTimes(1);
    });

    test("onAuditResult is gated on overlapping sessions just like persistence — round 18 F2", async () => {
      // computeLifecycleSignals over a snapshot built from the shared
      // `tools` map can produce false high_failure / low_adoption
      // signals during overlap windows because still-active sessions
      // have call counts in the map without matching sessionsUsed
      // updates yet. The callback must not fire until the active set
      // is drained.
      const callback = mock((_results: readonly unknown[]) => {});
      const mw = createToolAuditMiddleware(
        defaultConfig({
          onAuditResult: callback,
          highValueMinCalls: 1,
          highValueSuccessThreshold: 0.9,
        }),
      );
      const wrap = getWrapToolCall(mw);

      const sessA = sessionCtx({ sessionId: "sess-A" });
      const sessB = sessionCtx({ sessionId: "sess-B" });
      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);
      await wrap(turnCtx(sessA), toolReq("search"), async () => ({ output: "ok" }));
      await wrap(turnCtx(sessB), toolReq("read"), async () => ({ output: "ok" }));

      // A ends while B is still active — callback MUST NOT fire.
      await mw.onSessionEnd?.(sessA);
      expect(callback).toHaveBeenCalledTimes(0);

      // B ends — drains and fires once.
      await mw.onSessionEnd?.(sessB);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test("throwing onAuditResult does not abort onSessionEnd or skip store.save (round 10)", async () => {
      // Round 10: observe-phase telemetry must never abort session
      // teardown — a throwing sink would otherwise reject onSessionEnd
      // and skip persistence, leaving the snapshot unsaved.
      const errors: unknown[] = [];
      const { store, saves } = createMockStore();
      const mw = createToolAuditMiddleware(
        defaultConfig({
          store,
          onAuditResult: () => {
            throw new Error("sink boom");
          },
          onError: (e) => {
            errors.push(e);
          },
          highValueMinCalls: 1,
          highValueSuccessThreshold: 0.9,
        }),
      );
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      // onSessionEnd must NOT throw despite the sink failing.
      await expect(mw.onSessionEnd?.(sessionCtx())).resolves.toBeUndefined();

      expect(errors.length).toBe(1);
      expect((errors[0] as Error).message).toBe("sink boom");
      // Persistence must still happen.
      expect(saves.length).toBe(1);
    });

    test("retries a failed persist on the next session end even when otherwise clean — round 33 F1", async () => {
      // A transient store outage at session-end could strand committed
      // counters in memory: pendingPersist was cleared, the dirty flag
      // resets per session, and the early-return prevented retries on
      // subsequent clean sessions. Now pendingFailedPersist forces every
      // session end to retry until the write succeeds.
      let failNext = true;
      const saves: ToolAuditSnapshot[] = [];
      // let: stateful disk so the second save's load reflects accumulated state
      let stored: ToolAuditSnapshot = { tools: {}, totalSessions: 0, lastUpdatedAt: 0 };
      const store: ToolAuditStore = {
        load: () => stored,
        save: (s) => {
          if (failNext) {
            failNext = false;
            throw new Error("transient");
          }
          saves.push(s);
          stored = s;
        },
      };
      const onError = mock((_e: unknown) => {});
      const mw = createToolAuditMiddleware(defaultConfig({ store, onError }));
      const wrap = getWrapToolCall(mw);

      // Session A: tool call, then save fails.
      await mw.onSessionStart?.(sessionCtx({ sessionId: "A" }));
      await wrap(turnCtx(sessionCtx({ sessionId: "A" })), toolReq("search"), async () => ({
        output: "ok",
      }));
      await mw.onSessionEnd?.(sessionCtx({ sessionId: "A" }));
      expect(saves.length).toBe(0);
      expect(onError).toHaveBeenCalledTimes(1);

      // Session B: clean (no model or tool work). Must still retry the
      // failed write — round-33 contract.
      await mw.onSessionStart?.(sessionCtx({ sessionId: "B" }));
      await mw.onSessionEnd?.(sessionCtx({ sessionId: "B" }));
      expect(saves.length).toBe(1);
      expect(saves[0]?.tools.search?.callCount).toBe(1);
    });

    test("overlapping session ends with CAS rebase do not roll back rival increments — round 30 F1", async () => {
      // Round-29 built the snapshot at queue time, so a save earlier in
      // the chain that ran adoptNewBaseline could leave a later queued
      // save diffing against a newer baseline than its prebuilt snapshot
      // had observed — producing negative deltas that rolled back the
      // rebased counts. Round-30 rebuilds the snapshot inside the save
      // closure so each save diffs against the baseline it actually runs
      // against. This test pumps an overlap + CAS conflict and asserts
      // the final disk state contains BOTH writers' work.
      let diskVersion = 0;
      let diskSnapshot: ToolAuditSnapshot = {
        tools: {},
        totalSessions: 0,
        lastUpdatedAt: 0,
        version: diskVersion,
      };
      let conflictsToInject = 1;
      const store: ToolAuditStore = {
        load: () => diskSnapshot,
        save: () => {
          throw new Error("plain save should not be called when saveIfVersion is provided");
        },
        saveIfVersion: (snap, expected) => {
          if (expected !== diskVersion) {
            return { ok: false, current: diskSnapshot };
          }
          if (conflictsToInject > 0) {
            conflictsToInject -= 1;
            diskVersion += 1;
            diskSnapshot = {
              tools: {
                rival: {
                  toolName: "rival",
                  callCount: 5,
                  successCount: 5,
                  failureCount: 0,
                  lastUsedAt: 50,
                  avgLatencyMs: 1,
                  minLatencyMs: 1,
                  maxLatencyMs: 1,
                  totalLatencyMs: 5,
                  sessionsAvailable: 1,
                  sessionsUsed: 1,
                },
              },
              totalSessions: 1,
              lastUpdatedAt: 50,
              version: diskVersion,
            };
            return { ok: false, current: diskSnapshot };
          }
          diskVersion += 1;
          diskSnapshot = { ...snap, version: diskVersion };
          return { ok: true };
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      const sessA = sessionCtx({ sessionId: "sess-A" });
      const sessB = sessionCtx({ sessionId: "sess-B" });
      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);
      await wrap(turnCtx(sessA), toolReq("search"), async () => ({ output: "ok" }));
      await wrap(turnCtx(sessB), toolReq("read"), async () => ({ output: "ok" }));

      // Concurrent ends: A serializes through savePromise then B. The CAS
      // conflict rebases baseline mid-flight; B's later save must build
      // its snapshot from the rebased state, NOT from a prebuilt stale
      // snapshot.
      await Promise.all([mw.onSessionEnd?.(sessA), mw.onSessionEnd?.(sessB)]);

      // All three contributors must survive on disk: rival (CAS conflict
      // injection), search (sess-A), and read (sess-B). No counter rolled
      // back below the rebased baseline.
      expect(diskSnapshot.tools.rival?.callCount).toBe(5);
      expect(diskSnapshot.tools.search?.callCount).toBe(1);
      expect(diskSnapshot.tools.read?.callCount).toBe(1);
    });

    test("uses saveIfVersion CAS and retries on conflict — round 28 F1", async () => {
      // Multi-writer correctness: when the store advances disk between
      // our read and write (another runtime committed first), saveIfVersion
      // returns ok=false; we must adopt the new baseline, re-merge our
      // delta, and retry — preserving BOTH writers' increments.
      let diskVersion = 0;
      let diskSnapshot: ToolAuditSnapshot = {
        tools: {},
        totalSessions: 0,
        lastUpdatedAt: 0,
        version: diskVersion,
      };
      // let: simulates the OTHER writer landing one update mid-flight
      let conflictsToInject = 1;
      const store: ToolAuditStore = {
        load: () => diskSnapshot,
        save: () => {
          throw new Error("plain save should not be called when saveIfVersion is provided");
        },
        saveIfVersion: (snap, expected) => {
          if (expected !== diskVersion) {
            return { ok: false, current: diskSnapshot };
          }
          if (conflictsToInject > 0) {
            // Another writer commits first: bump disk to a never-before-seen
            // baseline that the caller must re-merge against.
            conflictsToInject -= 1;
            diskVersion += 1;
            diskSnapshot = {
              tools: {
                rival: {
                  toolName: "rival",
                  callCount: 7,
                  successCount: 7,
                  failureCount: 0,
                  lastUsedAt: 50,
                  avgLatencyMs: 1,
                  minLatencyMs: 1,
                  maxLatencyMs: 1,
                  totalLatencyMs: 7,
                  sessionsAvailable: 1,
                  sessionsUsed: 1,
                },
              },
              totalSessions: 1,
              lastUpdatedAt: 50,
              version: diskVersion,
            };
            return { ok: false, current: diskSnapshot };
          }
          diskVersion += 1;
          diskSnapshot = { ...snap, version: diskVersion };
          return { ok: true };
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      // Final disk state must contain BOTH writers' work — neither lost.
      expect(diskSnapshot.tools.search?.callCount).toBe(1);
      expect(diskSnapshot.tools.rival?.callCount).toBe(7);
    });

    test("persists immediately on session end even while OTHER sessions remain active — round 26 F2", async () => {
      // Round 26 (high): persistence used to defer until sessionStates was
      // empty. A long-lived or stuck session blocked all completed-session
      // writes process-wide; a crash before drain dropped them all.
      // Persistence now runs on every session end — loadAndMergeForSave's
      // read-modify-write merge keeps overlapping persists safe.
      const { store, saves } = createMockStore();
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      const sessA = sessionCtx({ sessionId: "sess-A" });
      const sessB = sessionCtx({ sessionId: "sess-B" });
      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);

      await wrap(turnCtx(sessA), toolReq("search"), async () => ({ output: "ok" }));
      await wrap(turnCtx(sessB), toolReq("read"), async () => ({ output: "ok" }));

      // A ends while B is still active — MUST persist now (not waiting
      // for B). Snapshot contains ONLY A's committed work — B's `read`
      // call lives in B's localTools and stays out of disk until B
      // completes (#review-round27-F2 isolation guarantee).
      await mw.onSessionEnd?.(sessA);
      expect(saves.length).toBe(1);
      expect(saves[0]?.tools.search?.callCount).toBe(1);
      expect(saves[0]?.tools.read).toBeUndefined();

      // B ends — persists a second time, now including B's read.
      await mw.onSessionEnd?.(sessB);
      expect(saves.length).toBe(2);
    });

    test("persisted snapshot omits in-flight tool calls from still-active sessions — round 27 F2", async () => {
      // wrapToolCall increments callCount at tool START. Without per-session
      // isolation, ending session A while session B has an in-flight tool
      // call would write B's started-but-not-completed call to disk; if the
      // process then crashes before B finishes, that phantom call persists
      // forever and skews lifecycle signals.
      const { store, saves } = createMockStore();
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      const sessA = sessionCtx({ sessionId: "sess-A" });
      const sessB = sessionCtx({ sessionId: "sess-B" });
      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);

      // A completes a tool; B starts one that never finishes.
      await wrap(turnCtx(sessA), toolReq("search"), async () => ({ output: "ok" }));
      // Simulate B's in-flight call: increment without awaiting completion.
      // (Equivalent to wrapToolCall mid-execution.)
      const bInFlight = wrap(turnCtx(sessB), toolReq("read"), async () => {
        await new Promise(() => {}); // never resolves
        return { output: "" };
      });
      // Yield once so the wrap's pre-call increment has a chance to land.
      await new Promise((r) => setTimeout(r, 0));

      // A ends — persisted snapshot must contain ONLY search, never B's read.
      await mw.onSessionEnd?.(sessA);
      expect(saves.length).toBe(1);
      expect(saves[0]?.tools.search?.callCount).toBe(1);
      expect(saves[0]?.tools.read).toBeUndefined();

      // Avoid leaking the in-flight promise.
      void bInFlight;
    });

    test("deferred signal emission is drained on the next completing session — round 26 F2", async () => {
      // Lifecycle signals must still defer under overlap to avoid false
      // low_adoption / high_failure flags from in-flight (not yet
      // finalized) session counters. The next session to complete drains
      // the deferred signal, even if it itself recorded no work.
      const auditResults: readonly unknown[][] = [];
      const onAuditResult = mock((s: readonly unknown[]) => {
        (auditResults as unknown[][]).push([...s]);
      });
      // Use a stateful store: round-30 builds the snapshot inside the
      // save closure and diffs against the just-saved baseline, so a
      // stateless mock (load always returns initial) would show
      // negative deltas after the first save.
      let stored: ToolAuditSnapshot = { tools: {}, totalSessions: 0, lastUpdatedAt: 0 };
      const store: ToolAuditStore = {
        load: () => stored,
        save: (s) => {
          stored = s;
        },
      };
      const mw = createToolAuditMiddleware(
        defaultConfig({
          store,
          onAuditResult,
          highValueMinCalls: 1,
          highValueSuccessThreshold: 0.9,
        }),
      );
      const wrap = getWrapToolCall(mw);

      const sessA = sessionCtx({ sessionId: "sess-A" });
      const sessB = sessionCtx({ sessionId: "sess-B" });
      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);

      await wrap(turnCtx(sessA), toolReq("search"), async () => ({ output: "ok" }));

      // A ends with overlap → signals deferred.
      await mw.onSessionEnd?.(sessA);
      expect(onAuditResult).toHaveBeenCalledTimes(0);

      // B ends with no work — must still drain the deferred signal.
      await mw.onSessionEnd?.(sessB);
      expect(onAuditResult).toHaveBeenCalled();
    });

    test("saves snapshot to store when dirty", async () => {
      const { store, saves } = createMockStore();
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      expect(saves.length).toBe(1);
      expect(saves[0]?.tools.search).toBeDefined();
    });

    test("skips save when dirty=false (no model or tool activity)", async () => {
      const { store, saves } = createMockStore();
      const mw = createToolAuditMiddleware(defaultConfig({ store }));

      await mw.onSessionStart?.(sessionCtx());
      await mw.onSessionEnd?.(sessionCtx());

      expect(saves.length).toBe(0);
    });

    test("saves when tools are offered but none called (availability tracking)", async () => {
      const { store, saves } = createMockStore();
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrapModel = getWrapModelCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrapModel(turnCtx(), modelReqWithTools(["search"]), async () => modelResponse());
      await mw.onSessionEnd?.(sessionCtx());

      expect(saves.length).toBe(1);
      expect(saves[0]?.tools.search?.sessionsAvailable).toBe(1);
      expect(saves[0]?.tools.search?.sessionsUsed).toBe(0);
    });

    test("increments sessionsUsed only for tools actually called", async () => {
      const mw = createToolAuditMiddleware(defaultConfig());
      const wrap = getWrapToolCall(mw);
      const wrapModel = getWrapModelCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      await wrapModel(turnCtx(), modelReqWithTools(["search", "read"]), async () =>
        modelResponse(),
      );
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));

      await mw.onSessionEnd?.(sessionCtx());

      const snapshot = mw.getSnapshot();
      expect(snapshot.tools.search?.sessionsUsed).toBe(1);
      expect(snapshot.tools.read?.sessionsUsed).toBe(0);
    });

    test("calls onError when store.save throws (does not crash session)", async () => {
      const errorCallback = mock((_e: unknown) => {});
      const store: ToolAuditStore = {
        load: () => ({ tools: {}, totalSessions: 0, lastUpdatedAt: 0 }),
        save: () => {
          throw new Error("disk full");
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store, onError: errorCallback }));
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await expect(mw.onSessionEnd?.(sessionCtx())).resolves.toBeUndefined();

      expect(errorCallback).toHaveBeenCalledTimes(1);
    });

    test("re-loads disk before save and merges another writer's deltas instead of overwriting them", async () => {
      // Simulate a second writer (another process) updating the store
      // in between this writer's hydrate and save. Without merge, our save
      // would clobber their callCount; with merge, both contributions
      // are preserved (max-merge for cumulative counters).
      // let: lastUpdatedAt grows on each external write to mimic disk state.
      let diskState: ToolAuditSnapshot = {
        tools: {
          search: {
            toolName: "search",
            callCount: 1,
            successCount: 1,
            failureCount: 0,
            lastUsedAt: 0,
            avgLatencyMs: 0,
            minLatencyMs: 0,
            maxLatencyMs: 0,
            totalLatencyMs: 0,
            sessionsAvailable: 1,
            sessionsUsed: 1,
          },
        },
        totalSessions: 1,
        lastUpdatedAt: 100,
      };
      const store: ToolAuditStore = {
        load: () => diskState,
        save: (s) => {
          diskState = s;
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      // We hydrate, then another writer lands a much higher call count.
      await mw.onSessionStart?.(sessionCtx());
      const initialSearch = diskState.tools.search;
      if (initialSearch === undefined) throw new Error("seed search record missing");
      diskState = {
        ...diskState,
        tools: {
          search: {
            ...initialSearch,
            callCount: 999,
            successCount: 999,
            sessionsUsed: 50,
          },
        },
        totalSessions: 50,
        lastUpdatedAt: 200, // newer than ours
      };

      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      // Persisted snapshot must include the other writer's larger counts —
      // not silently roll them back to our hydrated baseline + delta.
      expect(diskState.tools.search?.callCount).toBeGreaterThanOrEqual(999);
      expect(diskState.totalSessions).toBeGreaterThanOrEqual(50);
    });

    test("preserves both writers' increments under concurrent +1/+1 contention (no double-counting, no lost update)", async () => {
      // Round 9: max-merge silently drops one writer's increment when both
      // writers start from the same baseline N and each record +1 — the
      // result is N+1 instead of N+2. Baseline-delta merge keeps both.
      let diskState: ToolAuditSnapshot = {
        tools: {
          search: {
            toolName: "search",
            callCount: 5,
            successCount: 5,
            failureCount: 0,
            lastUsedAt: 0,
            avgLatencyMs: 0,
            minLatencyMs: 0,
            maxLatencyMs: 0,
            totalLatencyMs: 0,
            sessionsAvailable: 0,
            sessionsUsed: 0,
          },
        },
        totalSessions: 5,
        lastUpdatedAt: 100,
      };
      const store: ToolAuditStore = {
        load: () => diskState,
        save: (s) => {
          diskState = s;
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      // We hydrate at baseline=5, then another writer lands their own +1
      // (disk = 6) before we save our +1.
      await mw.onSessionStart?.(sessionCtx());
      const seedSearch = diskState.tools.search;
      if (seedSearch === undefined) throw new Error("seed search record missing");
      diskState = {
        ...diskState,
        tools: {
          search: { ...seedSearch, callCount: 6, successCount: 6 },
        },
        lastUpdatedAt: 150,
      };

      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      // Both writers' +1 must survive: 5 + 1 (other) + 1 (us) = 7.
      expect(diskState.tools.search?.callCount).toBe(7);
      expect(diskState.tools.search?.successCount).toBe(7);
    });

    test("concurrent session ends serialize through savePromise and both flush — round 26 F2", async () => {
      // Round 26 changed semantics: each session end persists
      // independently. Concurrent ends serialize through savePromise
      // (no overlapping store.save calls) but both run; the shared
      // savePromise chain prevents inter-leaved writes.
      const saveOrder: number[] = [];
      const saveSnapshots: ToolAuditSnapshot[] = [];
      // let: incremented per save invocation
      let saveIndex = 0;
      const store: ToolAuditStore = {
        load: () => ({ tools: {}, totalSessions: 0, lastUpdatedAt: 0 }),
        save: async (s) => {
          saveIndex += 1;
          await new Promise((r) => setTimeout(r, 5));
          saveOrder.push(saveIndex);
          saveSnapshots.push(s);
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      const ctxA = sessionCtx({ sessionId: "s-A" });
      const ctxB = sessionCtx({ sessionId: "s-B" });

      await mw.onSessionStart?.(ctxA);
      await wrap(turnCtx(ctxA), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionStart?.(ctxB);
      await wrap(turnCtx(ctxB), toolReq("read"), async () => ({ output: "ok" }));

      await Promise.all([mw.onSessionEnd?.(ctxA), mw.onSessionEnd?.(ctxB)]);

      expect(saveOrder).toEqual([1, 2]);
      const last = saveSnapshots[saveSnapshots.length - 1];
      expect(last?.tools.search).toBeDefined();
      expect(last?.tools.read).toBeDefined();
    });
  });

  describe("onSessionStart", () => {
    test("lazy-loads from store on first call and hydrates", async () => {
      const loadFn = mock(() => ({
        tools: {
          search: {
            toolName: "search",
            callCount: 10,
            successCount: 8,
            failureCount: 2,
            lastUsedAt: 500,
            avgLatencyMs: 25,
            minLatencyMs: 10,
            maxLatencyMs: 50,
            totalLatencyMs: 250,
            sessionsAvailable: 5,
            sessionsUsed: 3,
          },
        },
        totalSessions: 5,
        lastUpdatedAt: 500,
      }));
      const store: ToolAuditStore = { load: loadFn, save: () => {} };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));

      await mw.onSessionStart?.(sessionCtx());

      expect(loadFn).toHaveBeenCalledTimes(1);

      const snapshot = mw.getSnapshot();
      expect(snapshot.tools.search?.callCount).toBe(10);
    });

    test("concurrent first sessions share same load promise", async () => {
      // let: incremented in load callback
      let loadCount = 0;
      const store: ToolAuditStore = {
        load: async () => {
          loadCount += 1;
          return { tools: {}, totalSessions: 0, lastUpdatedAt: 0 };
        },
        save: () => {},
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));

      await Promise.all([mw.onSessionStart?.(sessionCtx()), mw.onSessionStart?.(sessionCtx())]);

      expect(loadCount).toBe(1);
    });

    test("calls onError when store.load throws (does not crash session start)", async () => {
      const errorCallback = mock((_e: unknown) => {});
      const store: ToolAuditStore = {
        load: () => {
          throw new Error("load failed");
        },
        save: () => {},
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store, onError: errorCallback }));

      await expect(mw.onSessionStart?.(sessionCtx())).resolves.toBeUndefined();
      expect(errorCallback).toHaveBeenCalledTimes(1);
    });

    test("retries store.load on a later session after a transient failure", async () => {
      // let: flips to a working snapshot on the second invocation.
      let callIndex = 0;
      const goodSnapshot = { tools: {}, totalSessions: 7, lastUpdatedAt: 100 };
      const store: ToolAuditStore = {
        load: () => {
          callIndex += 1;
          if (callIndex === 1) throw new Error("transient");
          return goodSnapshot;
        },
        save: () => {},
      };
      const errorCallback = mock((_e: unknown) => {});
      const mw = createToolAuditMiddleware(defaultConfig({ store, onError: errorCallback }));

      await mw.onSessionStart?.(sessionCtx());
      await mw.onSessionStart?.(sessionCtx());

      expect(callIndex).toBe(2);
      expect(errorCallback).toHaveBeenCalledTimes(1);
      // Session 1: load throws → totalSessions: 0 → 1.
      // Session 2: load succeeds → mergeSnapshotIntoMemory ADDS the disk
      // total (7) to the in-memory pre-hydration total (1) → 8, then
      // increments for the new session → 9. The merge prevents the
      // outage's session 1 from being lost when the store recovers.
      expect(mw.getSnapshot().totalSessions).toBe(9);
    });

    test("preserves activity recorded during a transient store.load outage", async () => {
      // let: callIndex differentiates the failing first load from the succeeding second load.
      let callIndex = 0;
      const diskSnapshot: ToolAuditSnapshot = {
        tools: {
          search: {
            toolName: "search",
            callCount: 5,
            successCount: 5,
            failureCount: 0,
            lastUsedAt: 100,
            avgLatencyMs: 10,
            minLatencyMs: 5,
            maxLatencyMs: 20,
            totalLatencyMs: 50,
            sessionsAvailable: 2,
            sessionsUsed: 2,
          },
        },
        totalSessions: 2,
        lastUpdatedAt: 100,
      };
      const savedSnapshots: ToolAuditSnapshot[] = [];
      const store: ToolAuditStore = {
        load: () => {
          callIndex += 1;
          if (callIndex === 1) throw new Error("transient");
          return diskSnapshot;
        },
        save: (s) => {
          savedSnapshots.push(s);
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      // Outage: session 1's load throws but the session still records activity.
      await mw.onSessionStart?.(sessionCtx({ sessionId: "outage-1" }));
      await wrap(turnCtx(sessionCtx({ sessionId: "outage-1" })), toolReq("search"), async () => ({
        output: "ok",
      }));
      await mw.onSessionEnd?.(sessionCtx({ sessionId: "outage-1" }));
      // Save should have been deferred because hydrated=false.
      expect(savedSnapshots.length).toBe(0);

      // Recovery: session 2's load succeeds and merges disk into memory.
      await mw.onSessionStart?.(sessionCtx({ sessionId: "outage-2" }));
      await wrap(turnCtx(sessionCtx({ sessionId: "outage-2" })), toolReq("search"), async () => ({
        output: "ok",
      }));
      await mw.onSessionEnd?.(sessionCtx({ sessionId: "outage-2" }));

      expect(savedSnapshots.length).toBe(1);
      const persisted = savedSnapshots[0];
      // Disk had 5 calls + 2 sessions; outage session added 1 call + 1 session;
      // recovery session added 1 call + 1 session. Merged = 7 calls / 4 sessions.
      expect(persisted?.tools.search?.callCount).toBe(7);
      expect(persisted?.totalSessions).toBe(4);
      expect(persisted?.tools.search?.sessionsUsed).toBe(4);
    });

    test("persists merged outage state on a later otherwise-clean session — round 25 F1", async () => {
      // After a load failure, deltas accumulate in memory. When a later
      // session hydrates successfully, the merge must mark a pending
      // persist so the next onSessionEnd flushes — even if that session
      // recorded no model/tool work. Otherwise a process restart drops
      // the recovered audit history.
      let callIndex = 0;
      const diskSnapshot: ToolAuditSnapshot = {
        tools: {},
        totalSessions: 0,
        lastUpdatedAt: 0,
      };
      const savedSnapshots: ToolAuditSnapshot[] = [];
      const store: ToolAuditStore = {
        load: () => {
          callIndex += 1;
          if (callIndex === 1) throw new Error("transient");
          return diskSnapshot;
        },
        save: (s) => {
          savedSnapshots.push(s);
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrap = getWrapToolCall(mw);

      // Outage session: load fails, but a tool call increments in-memory state.
      await mw.onSessionStart?.(sessionCtx({ sessionId: "outage" }));
      await wrap(turnCtx(sessionCtx({ sessionId: "outage" })), toolReq("search"), async () => ({
        output: "ok",
      }));
      await mw.onSessionEnd?.(sessionCtx({ sessionId: "outage" }));
      expect(savedSnapshots.length).toBe(0);

      // Recovery session: hydrates successfully, but does NO work.
      // The merge of outage deltas must still trigger a persist on end.
      await mw.onSessionStart?.(sessionCtx({ sessionId: "recovery" }));
      await mw.onSessionEnd?.(sessionCtx({ sessionId: "recovery" }));

      expect(savedSnapshots.length).toBe(1);
      expect(savedSnapshots[0]?.tools.search?.callCount).toBe(1);
    });

    test("does not emit lifecycle signals before initial hydration succeeds — round 24 F1", async () => {
      // A transient store outage produced false unused / low_adoption /
      // high_failure signals from outage-local in-memory counters, even
      // while persistence was correctly deferred. Both paths must be
      // gated on hydration.
      const onAuditResult = mock((_s: readonly unknown[]) => {});
      const store: ToolAuditStore = {
        load: () => {
          throw new Error("load failed");
        },
        save: () => {},
      };
      const mw = createToolAuditMiddleware(
        defaultConfig({
          store,
          onAuditResult,
          highValueMinCalls: 1,
          highValueSuccessThreshold: 0.9,
        }),
      );
      const wrapTool = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrapTool(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      expect(onAuditResult).toHaveBeenCalledTimes(0);
    });

    test("does not persist a fresh snapshot before initial hydration succeeds", async () => {
      const saveFn = mock((_s: ToolAuditSnapshot) => {});
      const store: ToolAuditStore = {
        load: () => {
          throw new Error("load failed");
        },
        save: saveFn,
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrapTool = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrapTool(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await mw.onSessionEnd?.(sessionCtx());

      expect(saveFn).toHaveBeenCalledTimes(0);
    });

    test("hydrates exactly once across concurrent first sessions even when snapshot is empty", async () => {
      // Empty snapshot is the historical pitfall: tools.size === 0 sentinel
      // would re-hydrate on every concurrent start, double-resetting counters.
      // let: counts how many times the snapshot was applied to in-memory state.
      let appliedCount = 0;
      const store: ToolAuditStore = {
        load: async () => ({ tools: {}, totalSessions: 4, lastUpdatedAt: 0 }),
        save: (s) => {
          // Use the side-effect of save to verify state once both starts settle.
          appliedCount = s.totalSessions;
        },
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      const wrapTool = getWrapToolCall(mw);

      const ctxA = sessionCtx({ sessionId: "s-A" });
      const ctxB = sessionCtx({ sessionId: "s-B" });

      await Promise.all([mw.onSessionStart?.(ctxA), mw.onSessionStart?.(ctxB)]);
      await wrapTool(turnCtx(ctxA), toolReq("x"), async () => ({ output: "" }));
      await mw.onSessionEnd?.(ctxA);

      // 4 (snapshot) + 2 (concurrent starts) = 6. A double-hydration race
      // would reset to snapshot value before each increment and yield 5.
      // Assert via getSnapshot — the save side-effect is unreliable here
      // because round-26 persists on every session end and the test mock's
      // load is stateless, so a follow-up session-end would re-merge
      // against the stale disk and clobber appliedCount.
      expect(mw.getSnapshot().totalSessions).toBe(6);
      expect(appliedCount).toBe(6);
    });
  });

  describe("generateReport", () => {
    test("returns current lifecycle signals on demand", async () => {
      const mw = createToolAuditMiddleware(
        defaultConfig({ highValueMinCalls: 2, highValueSuccessThreshold: 0.9 }),
      );
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());

      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      // generateReport defers signals while sessions are active or before
      // hydration (#review-round28-F2); end the session before asserting.
      await mw.onSessionEnd?.(sessionCtx());

      const report = mw.generateReport();
      const highValue = report.find((r) => r.toolName === "search" && r.signal === "high_value");
      expect(highValue).toBeDefined();
    });

    test("returns empty while sessions are active — round 28 F2", async () => {
      const mw = createToolAuditMiddleware(
        defaultConfig({ highValueMinCalls: 1, highValueSuccessThreshold: 0.9 }),
      );
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));
      // Session still open — signals must NOT fire.
      expect(mw.generateReport()).toEqual([]);
    });

    test("returns empty before initial hydration succeeds — round 28 F2", async () => {
      const store: ToolAuditStore = {
        load: () => {
          throw new Error("load failed");
        },
        save: () => {},
      };
      const mw = createToolAuditMiddleware(defaultConfig({ store }));
      // Never started a session, never hydrated → no signals.
      expect(mw.generateReport()).toEqual([]);
    });
  });

  describe("getSnapshot", () => {
    test("returns serializable state with totalSessions", async () => {
      const mw = createToolAuditMiddleware(defaultConfig());
      const wrap = getWrapToolCall(mw);

      await mw.onSessionStart?.(sessionCtx());
      await wrap(turnCtx(), toolReq("search"), async () => ({ output: "ok" }));

      const snapshot = mw.getSnapshot();
      expect(snapshot.totalSessions).toBe(1);
      expect(snapshot.tools.search).toBeDefined();
      expect(typeof snapshot.lastUpdatedAt).toBe("number");
    });
  });
});
