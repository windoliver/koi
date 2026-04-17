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
    const c2 = await runTurn(mw, session, 2); // idle=2 at start → fire, then reset to 0
    expect(extractInjected(c2)).toBeDefined();
    const c3 = await runTurn(mw, session, 3); // idle=0 at start
    expect(extractInjected(c3)).toBeUndefined();
    const c4 = await runTurn(mw, session, 4); // idle=1 at start
    expect(extractInjected(c4)).toBeUndefined();
    const c5 = await runTurn(mw, session, 5); // idle=2 at start → fire again
    expect(extractInjected(c5)).toBeDefined();
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

  test("custom isTaskTool without isMutatingTaskTool: read-only custom tools do NOT latch suppression", async () => {
    // When only `isTaskTool` is customized, mutation classification falls back
    // to the curated default (`@koi/task-tools` mutators only). A custom tool
    // that isn't in the default mutating set is treated as read-only, so a
    // blocked turn running it won't suppress the empty-board nudge on retry.
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({
      getBoard: () => board,
      idleTurnThreshold: 1,
      isTaskTool: (id) => id === "custom_readonly_task",
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0, { toolId: "bash" }); // sawAnyTool=true, idle=1

    // Turn 1 (blocked): custom read-only tool runs. Default mutating predicate
    // does NOT match it, so forceRequiresTasks stays false.
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx1);
    const okTool: ToolHandler = async () => ({ output: { ok: true } });
    await mw.wrapToolCall?.(ctx1, { toolId: "custom_readonly_task", input: {} }, okTool);
    await mw.onAfterTurn?.(ctx1);

    // Turn 2 (retry, board still empty): nudge fires normally — read-only
    // tool didn't mutate the board, so there's nothing to protect.
    const c2 = await runTurn(mw, session, 2);
    const text = (extractInjected(c2)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("task_create");
  });

  test("custom isTaskTool + isMutatingTaskTool predicates", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({
      getBoard: () => board,
      idleTurnThreshold: 2,
      isTaskTool: (id) => id === "custom_task_tool",
      isMutatingTaskTool: (id) => id === "custom_task_tool",
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
    // Empty-board nudge requires prior task-tool engagement (round-9 fix).
    // A task_list read sets `sawTaskTool` without latching mutation rollback.
    await runTurn(mw, session, 0, { toolId: "task_list" }); // sawTaskTool=true, idle=0 (reset)
    await runTurn(mw, session, 1); // idle=1
    await runTurn(mw, session, 2); // idle=2
    const c3 = await runTurn(mw, session, 3); // idle=2 at start → fire
    const injected = extractInjected(c3);
    expect(injected).toBeDefined();
    const text = (injected?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("task_create");
  });

  test("empty-board nudge does NOT fire when only non-task tool was used (shell-only session)", async () => {
    // Round-9 regression: a CLI session using only shell/bash shouldn't get
    // pushed toward task decomposition via task_create nudges.
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0, { toolId: "bash" }); // idle=1 but sawTaskTool stays false
    const c1 = await runTurn(mw, session, 1); // idle=1 ≥ K, but no task-tool engagement
    expect(extractInjected(c1)).toBeUndefined();
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

describe("createTaskAnchorMiddleware — retry/stop-gate preservation", () => {
  test("stop-gate blocked turn with injection forces re-inject on retry", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: idle=0, no fire. After: idle=1.
    await runTurn(mw, session, 0);

    // Turn 1: idle=1 → FIRE. Turn is then blocked by stop gate.
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    const capture: Capture = {};
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeRequest(), captureHandler(capture));
    expect(extractInjected(capture)).toBeDefined();
    await mw.onAfterTurn?.(ctx1);

    // Turn 2 (retry): forceInjectNextTurn flag must re-fire injection.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeDefined();
  });

  test("blocked turn with task-tool activity forces re-inject on retry (retry loses tool context)", async () => {
    // The engine rebuilds the stop-gate retry input from the original user
    // messages — the blocked turn's tool exchange is NOT carried forward.
    // So task mutations made during the blocked turn must be re-surfaced
    // to the model via a fresh reminder on the retry turn.
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 5 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0 (blocked): task_create runs BEFORE threshold would trigger.
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const toolHandler: ToolHandler = async () => ({ output: "ok" });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_create", input: {} }, toolHandler);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1 (retry): even though idle < K, forceInjectNextTurn should fire.
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeDefined();
  });

  test("non-blocked turn with task-tool activity resets idle (reminder stale)", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0); // idle=1
    await runTurn(mw, session, 1, { toolId: "task_update" }); // non-blocked, resets idle=0
    const c2 = await runTurn(mw, session, 2); // idle=1
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("wrapModelCall commits idle=0 synchronously — error path does not re-arm", async () => {
    // Simulates the engine's non-stop-gate error path where onAfterTurn is
    // skipped: if we deferred the idle reset, the session would stay armed
    // and every subsequent turn would inject again. The synchronous commit
    // in wrapModelCall prevents that prompt-bloat runaway.
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0); // idle=1

    // Turn 1: inject fires. Simulate downstream throw: no onAfterTurn.
    const ctx1 = makeTurnCtx(session, 1);
    await mw.onBeforeTurn?.(ctx1);
    const throwingHandler: ModelHandler = async () => {
      throw new Error("downstream guard failure");
    };
    let threw = false;
    try {
      await mw.wrapModelCall?.(ctx1, makeRequest(), throwingHandler);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Note: onAfterTurn is intentionally NOT called — simulating the error path.

    // Turn 2: should NOT fire because idle was cleared synchronously.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("repeated blocked turns with no task activity still advance idle toward threshold", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Two stop-blocked turns with no task activity: idle must still climb.
    for (const i of [0, 1]) {
      const ctx: TurnContext = { ...makeTurnCtx(session, i), stopBlocked: true };
      await mw.onBeforeTurn?.(ctx);
      // No wrapModelCall → no injection. No wrapToolCall → no task tool.
      await mw.onAfterTurn?.(ctx);
    }

    // Turn 2: idle should now be 2 ≥ threshold → fire.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeDefined();
  });

  test("hook-blocked task_create (metadata.blockedByHook=true) does NOT count as mutation", async () => {
    // Runtime hook-veto contract: blocked tool calls return a normal ToolResponse
    // but carry `metadata.blockedByHook === true`. The board never changed, so
    // this middleware must not flip `taskToolThisTurn` / `mutatingTaskToolThisTurn`.
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0); // idle=1
    const ctx1 = makeTurnCtx(session, 1);
    await mw.onBeforeTurn?.(ctx1);
    const hookBlockedTool: ToolHandler = async () => ({
      output: { error: "blocked by hook" },
      metadata: { blockedByHook: true },
    });
    await mw.wrapToolCall?.(ctx1, { toolId: "task_create", input: {} }, hookBlockedTool);
    await mw.onAfterTurn?.(ctx1);

    // Turn 2: idle should be 2 (hook-block didn't reset it) → fire.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeDefined();
  });

  test("task_create returning { ok: false } does NOT count as mutation on normal turn", async () => {
    // Non-throwing failure: @koi/task-tools returns `{ ok: false, error }`
    // for schema/validation rejections. Previously this would reset idle and
    // delay the next reminder even though the board is unchanged.
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 2 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    await runTurn(mw, session, 0); // idle=1
    // Turn 1: task_create resolves with { ok: false, error: "..." }.
    const ctx1 = makeTurnCtx(session, 1);
    await mw.onBeforeTurn?.(ctx1);
    const failingTool: ToolHandler = async () => ({
      output: { ok: false, error: "schema violation" },
    });
    await mw.wrapToolCall?.(ctx1, { toolId: "task_create", input: {} }, failingTool);
    await mw.onAfterTurn?.(ctx1);

    // Turn 2: idle should be 2 (failure did NOT reset it) → fire.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeDefined();
  });

  test("task_create returning { ok: false } on blocked turn keeps empty-board nudge on retry", async () => {
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Pre-heat sawTaskTool via a successful task_list read.
    await runTurn(mw, session, 0, { toolId: "task_list" });

    // Turn 1 (blocked): task_create validation fails (returns { ok: false }).
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx1);
    const failingTool: ToolHandler = async () => ({
      output: { ok: false, error: "validation failed" },
    });
    await mw.wrapToolCall?.(ctx1, { toolId: "task_create", input: {} }, failingTool);
    await mw.onAfterTurn?.(ctx1);

    // Turn 2 (retry): board still empty, failed task_create didn't mutate
    // anything, so forceRequiresTasks must NOT be set — nudge should fire.
    const c2 = await runTurn(mw, session, 2);
    const text = (extractInjected(c2)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("task_create");
  });

  test("failed task_create on blocked turn does NOT suppress empty-board nudge on retry", async () => {
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    // Pre-heat sawTaskTool via a prior successful task_list. Without this,
    // the nudge stays dormant (round-10 semantics: nudge requires genuine
    // task-board interaction, not failed attempts).
    await runTurn(mw, session, 0, { toolId: "task_list" });

    // Turn 1 (blocked): task_create throws → no mutation flag gets set.
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx1);
    const throwingTool: ToolHandler = async () => {
      throw new Error("task_create failed");
    };
    let threw = false;
    try {
      await mw.wrapToolCall?.(ctx1, { toolId: "task_create", input: {} }, throwingTool);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await mw.onAfterTurn?.(ctx1);

    // Turn 2 (retry, board still empty): nudge fires — failed task_create did
    // not mutate the board, so `forceRequiresTasks` was never latched.
    const c2 = await runTurn(mw, session, 2);
    const retryText = (extractInjected(c2)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(retryText).toContain("task_create");
  });

  test("denied task-tool attempts alone do NOT enable the empty-board nudge (no engagement loop)", async () => {
    // Round-10 regression: a session where every task-tool call is denied
    // must not spin into a "call task_create → denied → nudge → call task_create"
    // loop. sawTaskTool stays false until a SUCCESSFUL non-blocked call lands.
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: task_create returns { ok: false } (denied by validation).
    const ctx0 = makeTurnCtx(session, 0);
    await mw.onBeforeTurn?.(ctx0);
    const deniedTool: ToolHandler = async () => ({
      output: { ok: false, error: "permission denied" },
    });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_create", input: {} }, deniedTool);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1 (idle=1≥1): would nudge if sawTaskTool was set, but denied
    // attempts should NOT latch it.
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();
  });

  test("getBoard returning undefined (no-board contract) clears the force flag", async () => {
    // Per TaskBoardAccessor: undefined = "no board for this session" (legitimate).
    // Distinct from a throw, which means transient backend failure.
    const populated = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    let mode: "populated" | "none" = "populated";
    const mw = createTaskAnchorMiddleware({
      getBoard: () => (mode === "populated" ? populated : undefined),
      idleTurnThreshold: 5,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Arm forceInjectNextTurn via blocked task_create.
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const okTool: ToolHandler = async () => ({ output: { ok: true } });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_create", input: {} }, okTool);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: getBoard returns undefined (legitimate "no board"). Force must clear.
    mode = "none";
    await runTurn(mw, session, 1);

    // Turn 2: board reappears. Since undefined cleared force, injection must NOT fire
    // (idle below threshold, no forced path).
    mode = "populated";
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("getBoard throw on forced retry preserves the force flag for next attempt", async () => {
    // Per contract: a thrown error = transient backend failure. Must keep
    // forceInjectNextTurn armed so the next turn retries.
    const populated = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    let throwNext = false;
    const mw = createTaskAnchorMiddleware({
      getBoard: () => {
        if (throwNext) throw new Error("transient backend failure");
        return populated;
      },
      idleTurnThreshold: 5,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0 (blocked, task_create succeeds) arms forceInjectNextTurn.
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const okTool: ToolHandler = async () => ({ output: { ok: true } });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_create", input: {} }, okTool);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: forced retry, but getBoard throws → no injection this turn.
    throwNext = true;
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();

    // Turn 2: board comes back. Force flag must have survived turn 1's
    // transient failure → injection fires even though idle < threshold.
    throwNext = false;
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeDefined();
  });

  test("blocked read-only task_list does NOT latch empty-board suppression", async () => {
    // Read-only task tools (task_list/task_get/task_output) can't mutate the
    // board, so a blocked turn that only read state must not set forceRequiresTasks.
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0, { toolId: "bash" }); // sawAnyTool=true, idle=1

    // Turn 1 (blocked): successful task_list — read-only.
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx1);
    const okTool: ToolHandler = async () => ({ output: { ok: true, tasks: [] } });
    await mw.wrapToolCall?.(ctx1, { toolId: "task_list", input: {} }, okTool);
    await mw.onAfterTurn?.(ctx1);

    // Turn 2 (retry, board still empty): nudge must fire — read-only call
    // cannot have completed work.
    const c2 = await runTurn(mw, session, 2);
    const text = (extractInjected(c2)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("task_create");
  });

  test("forceRequiresTasks survives: blocked mutating → forced retry observes empty → retry itself blocked → next turn still suppressed", async () => {
    // Round-5 regression: the empty-observed path cleared forceRequiresTasks
    // before the retry's success was known. A stop-gate on the retry then lost
    // the suppression, letting the next turn emit a `task_create` nudge.
    let boardTasks: readonly Task[] = [
      makeTask({ id: tid("t1"), subject: "A", status: "pending" }),
    ];
    const mw = createTaskAnchorMiddleware({
      getBoard: () => makeBoard(boardTasks),
      idleTurnThreshold: 1,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0 (blocked + task_update completes last task): latches both force flags.
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const okTool: ToolHandler = async () => ({ output: { ok: true } });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_update", input: {} }, okTool);
    boardTasks = []; // board empty after mutation
    await mw.onAfterTurn?.(ctx0);

    // Turn 1 (forced retry, empty-observed): suppressed. Then stop-gated again.
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx1);
    const capture1: Capture = {};
    await mw.wrapModelCall?.(ctx1, makeRequest(), captureHandler(capture1));
    expect(extractInjected(capture1)).toBeUndefined(); // empty-board + suppression
    await mw.onAfterTurn?.(ctx1);

    // Turn 2 (next retry, board STILL empty): nudge MUST still be suppressed.
    // The latch was restored on turn-1's blocked rollback.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("forceRequiresTasks survives a second blocked retry whose board becomes empty between attempts", async () => {
    // Round-1 ordering bug: after a blocked mutating turn, the retry was
    // allowed to clear `forceRequiresTasks` at injection time. If that retry
    // was itself stop-blocked without another mutating tool, protection was
    // lost — and if the board then became empty (e.g., a background child
    // agent completed), the NEXT retry could emit a spurious task_create nudge.
    const initialTasks: Task[] = [makeTask({ id: tid("t1"), subject: "A", status: "pending" })];
    let board = makeBoard(initialTasks);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0 (blocked, mutating): task_update → arms both force flags.
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const okTool: ToolHandler = async () => ({ output: { ok: true } });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_update", input: {} }, okTool);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1 (forced retry, board STILL has the task so inject fires, then
    // stop-gate blocks again without any task tool running).
    const ctx1: TurnContext = { ...makeTurnCtx(session, 1), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx1);
    const capture1: Capture = {};
    await mw.wrapModelCall?.(ctx1, makeRequest(), captureHandler(capture1));
    expect(extractInjected(capture1)).toBeDefined();
    await mw.onAfterTurn?.(ctx1);

    // Between retries, a background agent completes the task → board empty.
    board = makeBoard([]);

    // Turn 2 (forced retry, board empty): the empty-board nudge MUST stay
    // suppressed — forceRequiresTasks must have survived turn 1's second block.
    const c2 = await runTurn(mw, session, 2);
    expect(extractInjected(c2)).toBeUndefined();
  });

  test("forceRequiresTasks suppression lifts after the immediate retry window", async () => {
    // After a blocked mutating turn leaves the board empty, the very-next
    // retry must not nudge `task_create` (that would ask the model to recreate
    // just-finished work). But the suppression must NOT be permanent — later
    // multi-step requests in the same session still need the empty-board nudge.
    const tasks: Task[] = [makeTask({ id: tid("t1"), subject: "A", status: "pending" })];
    let board = makeBoard(tasks);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0 (blocked): task_update completes last task; board goes empty.
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const okTool: ToolHandler = async () => ({ output: { ok: true } });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_update", input: {} }, okTool);
    board = makeBoard([]);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1 (forced retry, empty board): suppressed — no nudge.
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();

    // Turn 2: board still empty but suppression has lifted. Idle grows until
    // threshold, then the empty-board nudge can fire again for new requests.
    const c2 = await runTurn(mw, session, 2);
    const text = (extractInjected(c2)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("task_create");
  });

  test("blocked empty-board nudge re-injects the nudge on retry (board still empty)", async () => {
    const board = makeBoard([]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: task_list sets sawTaskTool=true AND resets idle to 0 after turn.
    await runTurn(mw, session, 0, { toolId: "task_list" });
    await runTurn(mw, session, 1); // idle=1 after

    // Turn 2 (blocked): shouldInject=true (idle=1≥1) + empty board + sawTaskTool → nudge fires.
    const ctx2: TurnContext = { ...makeTurnCtx(session, 2), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx2);
    const capture2: Capture = {};
    await mw.wrapModelCall?.(ctx2, makeRequest(), captureHandler(capture2));
    const nudgeText =
      (extractInjected(capture2)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(nudgeText).toContain("task_create");
    await mw.onAfterTurn?.(ctx2);

    // Turn 3 (retry, board still empty): nudge must be re-injected.
    const c3 = await runTurn(mw, session, 3);
    const retryText = (extractInjected(c3)?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(retryText).toContain("task_create");
  });

  test("blocked turn that emptied the board does NOT push empty-board nudge on retry", async () => {
    // Regression: if the blocked turn completed the last task, the forced
    // retry must not inject a generic nudge telling the model to task_create
    // again — that would ask the model to recreate work that just finished.
    const tasks: Task[] = [makeTask({ id: tid("t1"), subject: "A", status: "pending" })];
    let board = makeBoard(tasks);
    const mw = createTaskAnchorMiddleware({
      getBoard: () => board,
      idleTurnThreshold: 5,
      nudgeOnEmptyBoard: true,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0 (blocked): task_update runs, then the board is cleared (simulating
    // task completion / cleanup within the same blocked turn).
    const ctx0: TurnContext = { ...makeTurnCtx(session, 0), stopBlocked: true };
    await mw.onBeforeTurn?.(ctx0);
    const toolHandler: ToolHandler = async () => ({ output: "ok" });
    await mw.wrapToolCall?.(ctx0, { toolId: "task_update", input: {} }, toolHandler);
    board = makeBoard([]); // board now empty
    await mw.onAfterTurn?.(ctx0);

    // Turn 1 (retry): forced injection is armed, but board is empty — must
    // NOT inject the nudge because we cannot distinguish "new work needed"
    // from "the just-completed work is gone".
    const c1 = await runTurn(mw, session, 1);
    expect(extractInjected(c1)).toBeUndefined();
  });

  test("wrapModelCall is idempotent within a single turn (no double-inject on same ctx)", async () => {
    const board = makeBoard([makeTask({ id: tid("t1"), subject: "A", status: "pending" })]);
    const mw = createTaskAnchorMiddleware({ getBoard: () => board, idleTurnThreshold: 1 });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await runTurn(mw, session, 0); // idle=1
    const ctx = makeTurnCtx(session, 1);
    await mw.onBeforeTurn?.(ctx);

    const first: Capture = {};
    await mw.wrapModelCall?.(ctx, makeRequest(), captureHandler(first));
    expect(extractInjected(first)).toBeDefined();

    // Second call within the same turn must NOT re-prepend the reminder.
    const second: Capture = {};
    await mw.wrapModelCall?.(ctx, makeRequest(), captureHandler(second));
    expect(extractInjected(second)).toBeUndefined();
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
