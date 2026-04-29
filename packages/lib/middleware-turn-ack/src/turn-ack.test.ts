import { describe, expect, test } from "bun:test";
import type {
  ChannelStatus,
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { TurnAckScheduler } from "./turn-ack.js";
import { createTurnAckMiddleware } from "./turn-ack.js";

// ---------------------------------------------------------------------------
// Manual scheduler
// ---------------------------------------------------------------------------

interface Manual {
  readonly scheduler: TurnAckScheduler;
  fire(): void;
  pendingCount(): number;
}

function makeScheduler(): Manual {
  const tasks = new Map<number, () => void>();
  let nextId = 1;

  return {
    scheduler: {
      setTimeout(handler, _ms) {
        const id = nextId++;
        tasks.set(id, handler);
        return id;
      },
      clearTimeout(handle) {
        if (typeof handle === "number") tasks.delete(handle);
      },
    },
    fire() {
      const pending = [...tasks.entries()];
      tasks.clear();
      for (const [, fn] of pending) fn();
    },
    pendingCount() {
      return tasks.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Recorder {
  readonly statuses: ChannelStatus[];
  readonly sendStatus: (s: ChannelStatus) => Promise<void>;
}

function makeRecorder(opts?: { readonly throwOn?: ChannelStatus["kind"] }): Recorder {
  const statuses: ChannelStatus[] = [];
  return {
    statuses,
    async sendStatus(s: ChannelStatus): Promise<void> {
      statuses.push(s);
      if (opts?.throwOn === s.kind) throw new Error("send failed");
    },
  };
}

function makeCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: {
      agentId: "test",
      sessionId: "s1" as never,
      runId: "r1" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t1" as never,
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function makeSessionCtx(sessionId = "s1"): SessionContext {
  return {
    agentId: "test",
    sessionId: sessionId as never,
    runId: "r1" as never,
    metadata: {},
  };
}

const noopToolNext: ToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({
  output: { ok: true },
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function callBeforeTurn(mw: KoiMiddleware, ctx: TurnContext): Promise<void> {
  if (mw.onBeforeTurn === undefined) throw new Error("no onBeforeTurn");
  return mw.onBeforeTurn(ctx);
}
function callAfterTurn(mw: KoiMiddleware, ctx: TurnContext): Promise<void> {
  if (mw.onAfterTurn === undefined) throw new Error("no onAfterTurn");
  return mw.onAfterTurn(ctx);
}
function callSessionEnd(mw: KoiMiddleware, ctx: SessionContext): Promise<void> {
  if (mw.onSessionEnd === undefined) throw new Error("no onSessionEnd");
  return mw.onSessionEnd(ctx);
}
function callTool(
  mw: KoiMiddleware,
  ctx: TurnContext,
  req: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  if (mw.wrapToolCall === undefined) throw new Error("no wrapToolCall");
  return mw.wrapToolCall(ctx, req, next);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("createTurnAckMiddleware shape", () => {
  const mw = createTurnAckMiddleware();

  test("name is 'turn-ack'", () => {
    expect(mw.name).toBe("turn-ack");
  });
  test("priority is 50", () => {
    expect(mw.priority).toBe(50);
  });
  test("phase is 'resolve'", () => {
    expect(mw.phase).toBe("resolve");
  });
  test("describeCapabilities returns label", () => {
    const cap = mw.describeCapabilities(makeCtx());
    expect(cap?.label).toBe("turn-ack");
  });
});

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

describe("turn lifecycle", () => {
  test("slow turn: processing fires after debounce, idle on after", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler, debounceMs: 50 });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });

    await callBeforeTurn(mw, ctx);
    expect(m.pendingCount()).toBe(1);
    m.fire();
    await flush();
    expect(rec.statuses).toEqual([{ kind: "processing", turnIndex: 0 }]);

    await callAfterTurn(mw, ctx);
    await flush();
    expect(rec.statuses).toEqual([
      { kind: "processing", turnIndex: 0 },
      { kind: "idle", turnIndex: 0 },
    ]);
  });

  test("fast turn: processing skipped, only idle", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });

    await callBeforeTurn(mw, ctx);
    // No fire — turn finishes before debounce
    await callAfterTurn(mw, ctx);
    await flush();

    expect(m.pendingCount()).toBe(0);
    expect(rec.statuses).toEqual([{ kind: "idle", turnIndex: 0 }]);
  });

  test("no sendStatus on context: no-op, no scheduler call", async () => {
    const m = makeScheduler();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx = makeCtx();

    await callBeforeTurn(mw, ctx);
    await callAfterTurn(mw, ctx);
    expect(m.pendingCount()).toBe(0);
  });

  test("emitted statuses include the correct turnIndex", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx = makeCtx({ sendStatus: rec.sendStatus, turnIndex: 7 });

    await callBeforeTurn(mw, ctx);
    m.fire();
    await callAfterTurn(mw, ctx);
    await flush();

    for (const s of rec.statuses) expect(s.turnIndex).toBe(7);
  });

  test("sendStatus rejection routed through onError, never thrown", async () => {
    const m = makeScheduler();
    const rec = makeRecorder({ throwOn: "idle" });
    const errors: unknown[] = [];
    const mw = createTurnAckMiddleware({
      scheduler: m.scheduler,
      onError: (e) => errors.push(e),
    });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });

    await callBeforeTurn(mw, ctx);
    await callAfterTurn(mw, ctx);
    await flush();
    expect(errors).toHaveLength(1);
  });

  test("multiple turns: each gets independent debounce", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx0 = makeCtx({ sendStatus: rec.sendStatus, turnIndex: 0 });
    const ctx1 = makeCtx({ sendStatus: rec.sendStatus, turnIndex: 1 });

    await callBeforeTurn(mw, ctx0);
    await callAfterTurn(mw, ctx0);
    expect(m.pendingCount()).toBe(0);

    await callBeforeTurn(mw, ctx1);
    expect(m.pendingCount()).toBe(1);
    await callAfterTurn(mw, ctx1);
    expect(m.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

describe("wrapToolCall", () => {
  test("emits processing status with detail", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx = makeCtx({ sendStatus: rec.sendStatus, turnIndex: 3 });

    await callTool(mw, ctx, { toolId: "search", input: {} }, noopToolNext);
    await flush();

    expect(rec.statuses).toEqual([{ kind: "processing", turnIndex: 3, detail: "calling search" }]);
  });

  test("toolStatus disabled: no status emitted", async () => {
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ toolStatus: false });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });

    await callTool(mw, ctx, { toolId: "search", input: {} }, noopToolNext);
    await flush();

    expect(rec.statuses).toEqual([]);
  });

  test("no sendStatus: no-op, tool still runs", async () => {
    const mw = createTurnAckMiddleware();
    let called = false;
    const next: ToolHandler = async () => {
      called = true;
      return { output: {} };
    };

    await callTool(mw, makeCtx(), { toolId: "search", input: {} }, next);
    expect(called).toBe(true);
  });

  test("sendStatus rejection does not block tool call", async () => {
    const rec = makeRecorder({ throwOn: "processing" });
    const errors: unknown[] = [];
    const mw = createTurnAckMiddleware({ onError: (e) => errors.push(e) });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });
    let called = false;
    const next: ToolHandler = async () => {
      called = true;
      return { output: {} };
    };

    const res = await callTool(mw, ctx, { toolId: "x", input: {} }, next);
    await flush();

    expect(called).toBe(true);
    expect(res.output).toEqual({});
    expect(errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("cleanup", () => {
  test("onSessionEnd cancels pending debounce timer", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });

    await callBeforeTurn(mw, ctx);
    expect(m.pendingCount()).toBe(1);

    await callSessionEnd(mw, makeSessionCtx());
    expect(m.pendingCount()).toBe(0);

    // Firing after cleanup must not produce a "processing" status
    m.fire();
    await flush();
    expect(rec.statuses).toEqual([]);
  });

  test("onBeforeTurn replaces a stale timer for the same session", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctx = makeCtx({ sendStatus: rec.sendStatus });

    await callBeforeTurn(mw, ctx);
    await callBeforeTurn(mw, ctx);
    // Only the second timer remains scheduled
    expect(m.pendingCount()).toBe(1);
    m.fire();
    await flush();
    expect(rec.statuses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Corner cases
// ---------------------------------------------------------------------------

describe("corner cases", () => {
  test("synchronous throw from sendStatus is routed through onError, not propagated", async () => {
    const errors: unknown[] = [];
    const mw = createTurnAckMiddleware({
      onError: (e) => errors.push(e),
      // Disable wrapToolCall path; we're testing the wrapToolCall emit path here.
    });
    // sendStatus throws synchronously rather than returning a rejecting Promise.
    const syncSendStatus: (s: ChannelStatus) => Promise<void> = (_s: ChannelStatus) => {
      throw new Error("channel exploded");
    };
    const syncThrowCtx: TurnContext = { ...makeCtx(), sendStatus: syncSendStatus };

    // Must not throw — the call returns the tool result normally.
    const res = await callTool(mw, syncThrowCtx, { toolId: "x", input: {} }, noopToolNext);
    await flush();

    expect(res.output).toEqual({ ok: true });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("channel exploded");
  });

  test("two concurrent sessions do not cancel each other's debounce timers", async () => {
    const m = makeScheduler();
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware({ scheduler: m.scheduler });
    const ctxA: TurnContext = {
      ...makeCtx({ sendStatus: rec.sendStatus, turnIndex: 0 }),
      session: {
        agentId: "a",
        sessionId: "session-A" as never,
        runId: "ra" as never,
        metadata: {},
      },
    };
    const ctxB: TurnContext = {
      ...makeCtx({ sendStatus: rec.sendStatus, turnIndex: 0 }),
      session: {
        agentId: "b",
        sessionId: "session-B" as never,
        runId: "rb" as never,
        metadata: {},
      },
    };

    await callBeforeTurn(mw, ctxA);
    await callBeforeTurn(mw, ctxB);
    expect(m.pendingCount()).toBe(2);

    // Firing both timers must produce two "processing" notifications,
    // proving that ctxB's onBeforeTurn did not cancel ctxA's timer.
    m.fire();
    await flush();
    expect(rec.statuses.filter((s) => s.kind === "processing")).toHaveLength(2);
  });

  test("tool throws after wrapToolCall emits processing status", async () => {
    const rec = makeRecorder();
    const mw = createTurnAckMiddleware();
    const ctx = makeCtx({ sendStatus: rec.sendStatus, turnIndex: 5 });
    const failing: ToolHandler = async () => {
      throw new Error("tool failed");
    };

    await expect(callTool(mw, ctx, { toolId: "search", input: {} }, failing)).rejects.toThrow(
      "tool failed",
    );
    await flush();

    expect(rec.statuses).toEqual([{ kind: "processing", turnIndex: 5, detail: "calling search" }]);
  });
});
