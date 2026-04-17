import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  SessionId,
  Task,
  TaskBoard,
  TaskItemId,
  ToolHandler,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";

import { createTaskAnchorMiddleware } from "./task-anchor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sid = (v: string): SessionId => sessionId(v);
const tid = (v: string): TaskItemId => v as TaskItemId;

function makeSessionCtx(v = "s1"): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sid(v),
    runId: runId("r1"),
    metadata: {},
  };
}

function makeTurnCtx(session: SessionContext, turnIndex: number): TurnContext {
  return {
    session,
    turnIndex,
    turnId: turnId(runId("r1"), turnIndex),
    messages: [],
    metadata: {},
  };
}

function makeRequest(): ModelRequest {
  return { messages: [] };
}

function makeResponse(): ModelResponse {
  return { content: "ok", model: "test-model" };
}

function makeTask(partial: Partial<Task> & Pick<Task, "id" | "subject" | "status">): Task {
  return {
    description: partial.subject,
    dependencies: [],
    retries: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function makeBoard(tasks: readonly Task[]): TaskBoard {
  const unimplemented = (): never => {
    throw new Error("not implemented in test fixture");
  };
  return {
    add: unimplemented,
    addAll: unimplemented,
    assign: unimplemented,
    unassign: unimplemented,
    complete: unimplemented,
    fail: unimplemented,
    kill: unimplemented,
    update: unimplemented,
    result: () => undefined,
    get: (id) => tasks.find((t) => t.id === id),
    ready: () => tasks.filter((t) => t.status === "pending"),
    pending: () => tasks.filter((t) => t.status === "pending"),
    blocked: () => [],
    inProgress: () => tasks.filter((t) => t.status === "in_progress"),
    completed: () => [],
    failed: () => tasks.filter((t) => t.status === "failed"),
    killed: () => tasks.filter((t) => t.status === "killed"),
    unreachable: () => [],
    dependentsOf: () => [],
    blockedBy: () => undefined,
    all: () => tasks,
    size: () => tasks.length,
  };
}

interface Capture {
  lastRequest?: ModelRequest;
}

function captureHandler(capture: Capture): ModelHandler {
  return async (req) => {
    capture.lastRequest = req;
    return makeResponse();
  };
}

function captureStream(capture: Capture): ModelStreamHandler {
  return (req) => {
    capture.lastRequest = req;
    const iter: AsyncIterable<ModelChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { kind: "done", response: makeResponse() };
      },
    };
    return iter;
  };
}

/** Simulate N complete turns on the middleware (onBeforeTurn → wrapModelCall → onAfterTurn). */
async function runTurn(
  mw: ReturnType<typeof createTaskAnchorMiddleware>,
  session: SessionContext,
  turnIndex: number,
  opts?: { toolId?: string },
): Promise<Capture> {
  const ctx = makeTurnCtx(session, turnIndex);
  const capture: Capture = {};
  await mw.onBeforeTurn?.(ctx);
  await mw.wrapModelCall?.(ctx, makeRequest(), captureHandler(capture));
  if (opts?.toolId !== undefined) {
    const tool: ToolHandler = async () => ({ output: "ok" });
    await mw.wrapToolCall?.(ctx, { toolId: opts.toolId, input: {} }, tool);
  }
  await mw.onAfterTurn?.(ctx);
  return capture;
}

function extractInjected(capture: Capture): InboundMessage | undefined {
  const msgs = capture.lastRequest?.messages ?? [];
  const first = msgs[0];
  if (first?.senderId?.startsWith("system:")) return first;
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTaskAnchorMiddleware — factory", () => {
  test("returns middleware with required fields", () => {
    const mw = createTaskAnchorMiddleware({ getBoard: () => undefined });
    expect(mw.name).toBe("task-anchor");
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("throws on invalid config", () => {
    expect(() => createTaskAnchorMiddleware({ idleTurnThreshold: 0 } as never)).toThrow();
    expect(() =>
      createTaskAnchorMiddleware({ getBoard: () => undefined, idleTurnThreshold: -1 }),
    ).toThrow();
  });
});

describe("createTaskAnchorMiddleware — idle injection with populated board", () => {
  test("does NOT fire before K idle turns", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 3 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const c0 = await runTurn(mw, session, 0);
    const c1 = await runTurn(mw, session, 1);
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c0)).toBeUndefined();
    expect(extractInjected(c1)).toBeUndefined();
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("fires on turn K with live task list", async () => {
    const board = makeBoard([
      makeTask({ id: tid("t1"), subject: "Audit auth code", status: "completed" }),
      makeTask({ id: tid("t2"), subject: "Migrate sessions", status: "pending" }),
    ]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    await runTurn(mw, session, 1);
    const c2 = await runTurn(mw, session, 2);
    const injected = extractInjected(c2);
    expect(injected).toBeDefined();
    const text = (injected?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("Audit auth code");
    expect(text).toContain("Migrate sessions");
    expect(text).toContain("</system-reminder>");
  });

  test("injected message has senderId 'system:task-anchor' (filtered from user transcript)", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    const c1 = await runTurn(mw, session, 1);
    const injected = extractInjected(c1);
    expect(injected?.senderId).toBe("system:task-anchor");
  });

  test("after injection, counter resets — next fire needs another K idle turns", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    await runTurn(mw, session, 1);
    const c2 = await runTurn(mw, session, 2); // idle=2 → fire
    expect(extractInjected(c2)).toBeDefined();
    const c3 = await runTurn(mw, session, 3); // idle=1 after reset
    expect(extractInjected(c3)).toBeUndefined();
    const c4 = await runTurn(mw, session, 4); // idle=2 → fire again
    expect(extractInjected(c4)).toBeDefined();
  });
});

describe("createTaskAnchorMiddleware — task-tool activity resets idle counter", () => {
  test("task_create resets counter — no injection after K idle-looking turns", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0); // idle=1
    await runTurn(mw, session, 1, { toolId: "task_create" }); // idle reset to 0
    const c2 = await runTurn(mw, session, 2); // idle=1
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("non-task tool does NOT reset counter", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0, { toolId: "bash" }); // idle=1
    await runTurn(mw, session, 1); // idle=2
    const c2 = await runTurn(mw, session, 2); // idle=2 at start → fire
    expect(extractInjected(c2)).toBeDefined();
  });

  test("custom isTaskTool predicate", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({
      getBoard: () => board,
      idleTurnThreshold: 2,
      isTaskTool: (id) => id === "custom_task_tool",
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    await runTurn(mw, session, 1, { toolId: "custom_task_tool" }); // reset
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeUndefined();
  });
});

describe("createTaskAnchorMiddleware — empty-board nudge", () => {
  test("nudges when board empty + any tool activity happened + idle >= K", async () => {
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0, { toolId: "bash" }); // tool activity, idle=1
    await runTurn(mw, session, 1); // idle=2
    const c2 = await runTurn(mw, session, 2); // idle=2 at start → fire
    const injected = extractInjected(c2);
    expect(injected).toBeDefined();
    const text = (injected?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("task_create");
  });

  test("no nudge when board empty + no tool activity yet", async () => {
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();
  });

  test("nudgeOnEmptyBoard: false disables nudge even with tool activity", async () => {
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({
      getBoard: () => board,
      idleTurnThreshold: 2,
      nudgeOnEmptyBoard: false,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0, { toolId: "bash" });
    await runTurn(mw, session, 1);
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeUndefined();
  });
});

describe("createTaskAnchorMiddleware — wrapModelStream parity", () => {
  test("stream variant also injects reminder", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await mw.onBeforeTurn?.(makeTurnCtx(session, 0));
    await mw.onAfterTurn?.(makeTurnCtx(session, 0));

    const ctx = makeTurnCtx(session, 1);
    await mw.onBeforeTurn?.(ctx);
    const capture: Capture = {};
    const iter = mw.wrapModelStream?.(ctx, makeRequest(), captureStream(capture));
    if (iter) for await (const _ of iter) void _;
    const injected = extractInjected(capture);
    expect(injected?.senderId).toBe("system:task-anchor");
  });
});

describe("createTaskAnchorMiddleware — async board accessor", () => {
  test("awaits Promise-returning getBoard", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({
      getBoard: async () => board,
      idleTurnThreshold: 1,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeDefined();
  });

  test("skips injection when getBoard throws", async () => {
    const mw = createTaskAnchorMiddleware({
      getBoard: () => {
        throw new Error("board unavailable");
      },
      idleTurnThreshold: 1,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();
  });

  test("skips injection when getBoard returns rejected Promise", async () => {
    const mw = createTaskAnchorMiddleware({
      getBoard: async () => {
        throw new Error("async fail");
      },
      idleTurnThreshold: 1,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();
  });
});

describe("createTaskAnchorMiddleware — session lifecycle", () => {
  test("isolates state across sessions", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const s1 = makeSessionCtx("s1");
    const s2 = makeSessionCtx("s2");
    await mw.onSessionStart?.(s1);
    await mw.onSessionStart?.(s2);

    await runTurn(mw, s1, 0);
    await runTurn(mw, s1, 1); // s1 fires
    const c = await runTurn(mw, s2, 0); // s2 still at idle=1
    expect(extractInjected(c)).toBeUndefined();
  });

  test("onSessionEnd drops state — next start is fresh", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0);
    await mw.onSessionEnd?.(session);

    // Model call without fresh start should not fire — no session state
    const ctx = makeTurnCtx(session, 1);
    const capture: Capture = {};
    await mw.wrapModelCall?.(ctx, makeRequest(), captureHandler(capture));
    expect(extractInjected(capture)).toBeUndefined();
  });

  test("wrapModelCall passes through when no session state exists", async () => {
    const mw = createTaskAnchorMiddleware({ getBoard: () => undefined });
    const session = makeSessionCtx();
    // NOTE: no onSessionStart called
    const ctx = makeTurnCtx(session, 0);
    const capture: Capture = {};
    const response = await mw.wrapModelCall?.(ctx, makeRequest(), captureHandler(capture));
    expect(response).toBeDefined();
    expect(extractInjected(capture)).toBeUndefined();
  });
});
