import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, ProcessId, ProcessState } from "@koi/core";
import { agentId } from "@koi/core";
import {
  clearAllDebugSessions,
  createDebugAttach,
  createDebugObserve,
  hasDebugSession,
} from "./create-debug-attach.js";

// ---------------------------------------------------------------------------
// Minimal Agent mock
// ---------------------------------------------------------------------------

function makeAgent(id = "agent-1"): Agent {
  const components = new Map<string, unknown>();
  const aid = agentId(id);
  const pid: ProcessId = { id: aid, name: id, type: "worker", depth: 0 };
  return {
    pid,
    manifest: {} as AgentManifest,
    state: "running" as ProcessState,
    component: <T>(token: import("@koi/core").SubsystemToken<T>) =>
      components.get(token as string) as T | undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

// ---------------------------------------------------------------------------
// Helpers to drive middleware hooks
// ---------------------------------------------------------------------------

async function fireTurnStart(
  mw: import("@koi/core").KoiMiddleware,
  turnIndex: number,
): Promise<void> {
  await mw.onBeforeTurn?.({ turnIndex } as import("@koi/core").TurnContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDebugAttach", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("returns session and middleware on success", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session).toBeDefined();
    expect(result.value.middleware).toBeDefined();
  });

  test("returns CONFLICT on second attach to same agent", () => {
    const agent = makeAgent();
    const first = createDebugAttach({ agent });
    expect(first.ok).toBe(true);

    const second = createDebugAttach({ agent });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONFLICT");
  });

  test("detach clears the session so re-attach succeeds", () => {
    const agent = makeAgent();
    const first = createDebugAttach({ agent });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    first.value.session.detach();

    const second = createDebugAttach({ agent });
    expect(second.ok).toBe(true);
  });

  test("hasDebugSession returns true while attached, false after detach", () => {
    const agent = makeAgent();
    const aid = agent.pid.id;
    expect(hasDebugSession(aid)).toBe(false);

    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    expect(hasDebugSession(aid)).toBe(true);

    if (result.ok) result.value.session.detach();
    expect(hasDebugSession(aid)).toBe(false);
  });

  test("breakpoint pauses on matching event, resume unblocks", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { session, middleware } = result.value;
    const events: string[] = [];

    session.onDebugEvent((e) => {
      events.push(e.kind);
    });

    session.breakOn({ kind: "turn", turnIndex: 0 });

    // Fire turn_start — should pause
    const pausePromise = fireTurnStart(middleware, 0);

    // Give the async gate a tick to pause
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state().kind).toBe("paused");

    // Resume
    const resumeResult = session.resume();
    expect(resumeResult.ok).toBe(true);

    await pausePromise;
    expect(session.state().kind).toBe("attached");
    expect(events).toContain("breakpoint_hit");
    expect(events).toContain("paused");
    expect(events).toContain("resumed");
  });

  test("once-breakpoint removed after first hit", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    session.breakOn({ kind: "turn" }, { once: true });
    expect((await session.inspect()).breakpoints).toHaveLength(1);

    const pausePromise = fireTurnStart(middleware, 0);
    await new Promise((r) => setTimeout(r, 0));
    session.resume();
    await pausePromise;

    expect((await session.inspect()).breakpoints).toHaveLength(0);
  });

  test("step adds one-shot breakpoint at next turn", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    // Pause at turn 0
    session.breakOn({ kind: "turn", turnIndex: 0 });
    const pause0 = fireTurnStart(middleware, 0);
    await new Promise((r) => setTimeout(r, 0));

    // Step — should add turn:1 one-shot BP and resume gate
    const stepResult = session.step();
    expect(stepResult.ok).toBe(true);
    await pause0;

    // Fire turn 1 — should pause again from step BP
    const pause1 = fireTurnStart(middleware, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state().kind).toBe("paused");
    session.resume();
    await pause1;
  });

  test("detach while paused auto-resumes", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    session.breakOn({ kind: "turn", turnIndex: 0 });
    const pausePromise = fireTurnStart(middleware, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state().kind).toBe("paused");

    // Detach — must not hang
    session.detach();
    await pausePromise;
    expect(session.state().kind).toBe("detached");
  });

  test("breakOn with error predicate throws VALIDATION error", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;

    expect(() => session.breakOn({ kind: "error" })).toThrow("error breakpoints are not supported");
  });

  test("wrapToolCall preserves caller callId and emits tool_result", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    const eventKinds: string[] = [];
    const callIds: string[] = [];
    session.onDebugEvent((e) => eventKinds.push(e.kind));

    const fakeCallId = "caller-provided-id";
    const fakeRequest: import("@koi/core").ToolRequest = {
      toolId: "my_tool",
      callId: fakeCallId,
      input: {},
    };
    const fakeNext = async (_r: import("@koi/core").ToolRequest) =>
      ({ output: "ok", callId: fakeCallId }) as import("@koi/core").ToolResponse;

    await middleware.wrapToolCall?.(
      { turnIndex: 0 } as import("@koi/core").TurnContext,
      fakeRequest,
      fakeNext,
    );

    const engineEvents = session.events();
    const startEvt = engineEvents.find((e) => e.kind === "tool_call_start") as Extract<
      import("@koi/core").EngineEvent,
      { kind: "tool_call_start" }
    >;
    const resultEvt = engineEvents.find((e) => e.kind === "tool_result");

    expect(startEvt).toBeDefined();
    expect(startEvt?.callId).toBe(fakeCallId);
    expect(resultEvt).toBeDefined();
  });

  test("resume on non-paused returns VALIDATION error", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;

    const res = session.resume();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("VALIDATION");
  });

  test("events() returns ring buffer tail", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    session.breakOn({ kind: "turn", turnIndex: 0 });
    const p = fireTurnStart(middleware, 0);
    await new Promise((r) => setTimeout(r, 0));
    session.resume();
    await p;

    const events = session.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.kind).toBe("turn_start");
  });
});

describe("createDebugObserve", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("returns NOT_FOUND when no session attached", () => {
    const agent = makeAgent();
    const result = createDebugObserve(agent.pid.id, agent);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns observer when session exists", () => {
    const agent = makeAgent();
    createDebugAttach({ agent });
    const result = createDebugObserve(agent.pid.id, agent);
    expect(result.ok).toBe(true);
  });

  test("observer inspectComponent paginates arrays correctly", () => {
    const agent = makeAgent();
    // Attach and set a large array component on the agent
    const largeArray = Array.from({ length: 100 }, (_, i) => i);
    (agent.components() as Map<string, unknown>).set("test:list", largeArray);

    const attachResult = createDebugAttach({ agent });
    if (!attachResult.ok) return;

    const observeResult = createDebugObserve(agent.pid.id, agent);
    if (!observeResult.ok) return;
    const observer = observeResult.value;

    const snap = observer.inspectComponent(
      "test:list" as import("@koi/core").SubsystemToken<number[]>,
      {
        limit: 10,
        offset: 5,
      },
    );

    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.totalItems).toBe(100);
    expect(snap.value.hasMore).toBe(true);
    expect(Array.isArray(snap.value.data)).toBe(true);
    expect((snap.value.data as number[]).length).toBe(10);
    expect((snap.value.data as number[])[0]).toBe(5);
  });

  test("observer receives debug events", async () => {
    const agent = makeAgent();
    const attachResult = createDebugAttach({ agent });
    if (!attachResult.ok) return;

    const observeResult = createDebugObserve(agent.pid.id, agent);
    if (!observeResult.ok) return;

    const { session, middleware } = attachResult.value;
    const observer = observeResult.value;

    const observed: string[] = [];
    observer.onDebugEvent((e) => observed.push(e.kind));

    session.breakOn({ kind: "turn", turnIndex: 0 });
    const p = fireTurnStart(middleware, 0);
    await new Promise((r) => setTimeout(r, 0));
    session.resume();
    await p;

    expect(observed).toContain("breakpoint_hit");
  });
});
