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

function sessionCtx(): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sessionId("sess-1"),
    runId: runId("run-1"),
    metadata: {},
  };
}

function turnCtx(): TurnContext {
  const rid = runId("run-1");
  return {
    session: sessionCtx(),
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
