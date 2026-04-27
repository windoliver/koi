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

    test("serializes concurrent saves so a slow earlier save cannot overwrite a faster later save", async () => {
      // Two onSessionEnd calls fire concurrently. The first save deliberately
      // takes longer than the second. Without serialization, the slow save
      // would settle last and clobber the newer snapshot. With serialization,
      // the second save MUST observe (and overwrite) the first's state.
      const saveOrder: number[] = [];
      const saveSnapshots: ToolAuditSnapshot[] = [];
      // let: incremented to differentiate first vs subsequent save calls.
      let saveIndex = 0;
      const store: ToolAuditStore = {
        load: () => ({ tools: {}, totalSessions: 0, lastUpdatedAt: 0 }),
        save: async (s) => {
          saveIndex += 1;
          const myIndex = saveIndex;
          // First save is slow; second is instant.
          if (myIndex === 1) await new Promise((r) => setTimeout(r, 30));
          saveOrder.push(myIndex);
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

      // Order MUST be deterministic — first then second, regardless of
      // which save was slower.
      expect(saveOrder).toEqual([1, 2]);
      // The final persisted snapshot includes both tools.
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

      const report = mw.generateReport();
      const highValue = report.find((r) => r.toolName === "search" && r.signal === "high_value");
      expect(highValue).toBeDefined();
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
