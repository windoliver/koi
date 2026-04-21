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

  test("breakOn with unsupported event_kind throws VALIDATION error", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;

    expect(() => session.breakOn({ kind: "event_kind", eventKind: "done" })).toThrow(
      'event_kind breakpoints for "done" are not supported',
    );
  });

  test("breakOn with supported event_kind does not throw", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;

    expect(() => session.breakOn({ kind: "event_kind", eventKind: "text_delta" })).not.toThrow();
    expect(() => session.breakOn({ kind: "event_kind", eventKind: "custom" })).not.toThrow();
    expect(() => session.breakOn({ kind: "event_kind", eventKind: "tool_result" })).not.toThrow();
  });

  test("throwing debug listener does not crash turn execution", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    // Register a listener that always throws
    session.onDebugEvent(() => {
      throw new Error("bad listener");
    });

    // Turn processing must not throw
    await expect(fireTurnStart(middleware, 0)).resolves.toBeUndefined();
  });

  test("wrapToolCall preserves caller callId and emits tool_result", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    const eventKinds: string[] = [];
    const _callIds: string[] = [];
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

  test("session inspectComponent returns immutable snapshot (not live reference)", () => {
    const agent = makeAgent();
    const inner = { value: 42 };
    const data = [inner];
    (agent.components() as Map<string, unknown>).set("test:live", data);

    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;

    const snap = session.inspectComponent(
      "test:live" as import("@koi/core").SubsystemToken<unknown>,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    // Mutate the live data — snapshot must remain unchanged
    inner.value = 999;
    const snapData = snap.value.data as Array<{ value: number }>;
    expect(snapData[0]?.value).toBe(42);
  });
});

describe("createDebugObserve", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("returns NOT_FOUND when no session attached", () => {
    const agent = makeAgent();
    const result = createDebugObserve(agent.pid.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("observer observes the originally attached agent, not caller-supplied one", () => {
    const agent = makeAgent("owner-agent");
    const otherAgentId = agentId("other-agent");
    (agent.components() as Map<string, unknown>).set("secret", { value: 42 });

    createDebugAttach({ agent });

    // createDebugObserve no longer accepts a separate agent — it uses the stored one
    const result = createDebugObserve(agent.pid.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const obs = result.value;

    // Observer must expose the attached agent's components (owner-agent)
    const snap = obs.inspectComponent("secret" as import("@koi/core").SubsystemToken<unknown>);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect((snap.value.data as { value: number }).value).toBe(42);

    // Unrelated agentId must return NOT_FOUND
    const notFound = createDebugObserve(otherAgentId);
    expect(notFound.ok).toBe(false);
    if (notFound.ok) return;
    expect(notFound.error.code).toBe("NOT_FOUND");
  });

  test("returns observer when session exists", () => {
    const agent = makeAgent();
    createDebugAttach({ agent });
    const result = createDebugObserve(agent.pid.id);
    expect(result.ok).toBe(true);
  });

  test("observer inspectComponent paginates arrays correctly", () => {
    const agent = makeAgent();
    // Attach and set a large array component on the agent
    const largeArray = Array.from({ length: 100 }, (_, i) => i);
    (agent.components() as Map<string, unknown>).set("test:list", largeArray);

    const attachResult = createDebugAttach({ agent });
    if (!attachResult.ok) return;

    const observeResult = createDebugObserve(agent.pid.id);
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

    const observeResult = createDebugObserve(agent.pid.id);
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

  test("observer inspectComponent returns immutable snapshot (not live reference)", () => {
    const agent = makeAgent();
    const inner = { value: 42 };
    const data = [inner];
    (agent.components() as Map<string, unknown>).set("test:arr", data);

    createDebugAttach({ agent });
    const observeResult = createDebugObserve(agent.pid.id);
    if (!observeResult.ok) return;
    const observer = observeResult.value;

    const snap = observer.inspectComponent(
      "test:arr" as import("@koi/core").SubsystemToken<unknown>,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    // Mutate the live array — snapshot must not change
    inner.value = 999;
    const snapData = snap.value.data as Array<{ value: number }>;
    expect(snapData[0]?.value).toBe(42);
  });

  test("observer inspectComponent returns VALIDATION error for non-cloneable component", () => {
    const agent = makeAgent();
    // Functions are not cloneable via structuredClone (DataCloneError)
    const nonCloneable: Record<string, unknown> = { fn: () => "hello" };
    (agent.components() as Map<string, unknown>).set("test:fn", nonCloneable);

    createDebugAttach({ agent });
    const observeResult = createDebugObserve(agent.pid.id);
    if (!observeResult.ok) return;
    const observer = observeResult.value;

    const snap = observer.inspectComponent(
      "test:fn" as import("@koi/core").SubsystemToken<unknown>,
    );
    expect(snap.ok).toBe(false);
    if (snap.ok) return;
    expect(snap.error.code).toBe("VALIDATION");
  });

  test("observer methods are revoked after session detach", () => {
    const agent = makeAgent();
    (agent.components() as Map<string, unknown>).set("test:data", [1, 2, 3]);

    const attachResult = createDebugAttach({ agent });
    if (!attachResult.ok) return;
    const { session } = attachResult.value;

    const observeResult = createDebugObserve(agent.pid.id);
    if (!observeResult.ok) return;
    const observer = observeResult.value;

    // Observer works before detach
    expect(observer.events()).toBeDefined();

    // Detach the session
    session.detach();

    // Observer access must now be revoked
    expect(() => observer.inspect()).toThrow("revoked");
    expect(observer.events()).toHaveLength(0);

    const snap = observer.inspectComponent(
      "test:data" as import("@koi/core").SubsystemToken<unknown>,
    );
    expect(snap.ok).toBe(false);
    if (snap.ok) return;
    expect(snap.error.code).toBe("VALIDATION");
  });
});

describe("createDebugAttach — bufferSize validation", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("returns VALIDATION error for bufferSize 0", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent, bufferSize: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error for negative bufferSize", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent, bufferSize: -5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error for non-integer bufferSize", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent, bufferSize: 1.5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("wrapToolCall emits tool_call_error custom event on thrown exception", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    const fakeRequest: import("@koi/core").ToolRequest = { toolId: "boom", input: {} };
    const fakeNext = async (
      _r: import("@koi/core").ToolRequest,
    ): Promise<import("@koi/core").ToolResponse> => {
      throw new Error("kaboom");
    };

    await expect(
      middleware.wrapToolCall?.(
        { turnIndex: 0 } as import("@koi/core").TurnContext,
        fakeRequest,
        fakeNext,
      ),
    ).rejects.toThrow("kaboom");

    const events = session.events();
    const errEvt = events.find(
      (e) =>
        e.kind === "custom" &&
        (e as Extract<import("@koi/core").EngineEvent, { kind: "custom" }>).type ===
          "tool_call_error",
    );
    expect(errEvt).toBeDefined();
  });
});

describe("turn breakpoint fires once per turn", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("turn breakpoint does not double-fire on turn_end", () => {
    const { matchesBreakpoint } =
      require("./breakpoint-matcher.js") as typeof import("./breakpoint-matcher.js");
    const turnStartCtx = { event: { kind: "turn_start" as const, turnIndex: 0 }, turnIndex: 0 };
    const turnEndCtx = { event: { kind: "turn_end" as const, turnIndex: 0 }, turnIndex: 0 };
    const predicate = { kind: "turn" as const };
    expect(matchesBreakpoint(predicate, turnStartCtx)).toBe(true);
    expect(matchesBreakpoint(predicate, turnEndCtx)).toBe(false);
  });
});

describe("step() count validation", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("step with count 0 returns VALIDATION error", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;
    const stepped = session.step({ count: 0 });
    expect(stepped.ok).toBe(false);
    if (stepped.ok) return;
    expect(stepped.error.code).toBe("VALIDATION");
  });

  test("step with negative count returns VALIDATION error", () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;
    const stepped = session.step({ count: -3 });
    expect(stepped.ok).toBe(false);
    if (stepped.ok) return;
    expect(stepped.error.code).toBe("VALIDATION");
  });
});

describe("observer.detach() revokes read access", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("observer methods are revoked after observer.detach() even when session still active", () => {
    const agent = makeAgent();
    (agent.components() as Map<string, unknown>).set("test:data", [1, 2, 3]);

    const attachResult = createDebugAttach({ agent });
    if (!attachResult.ok) return;
    const { session } = attachResult.value;

    const observeResult = createDebugObserve(agent.pid.id);
    if (!observeResult.ok) return;
    const observer = observeResult.value;

    // Detach only the observer (session still active)
    observer.detach();
    expect(() => observer.inspect()).toThrow("revoked");
    expect(observer.events()).toHaveLength(0);
    const snap = observer.inspectComponent(
      "test:data" as import("@koi/core").SubsystemToken<unknown>,
    );
    expect(snap.ok).toBe(false);
    if (snap.ok) return;
    expect(snap.error.code).toBe("VALIDATION");

    // Session itself still works
    expect(session.events()).toBeDefined();
    session.detach();
  });
});

describe("createDebugAttach — stale session auto-expiry", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("re-attach succeeds after controller is deactivated externally (stale entry)", () => {
    const agent = makeAgent();
    const first = createDebugAttach({ agent });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    clearAllDebugSessions();

    // Re-attach should succeed (stale entry cleaned up)
    const second = createDebugAttach({ agent });
    expect(second.ok).toBe(true);
  });

  test("re-attach succeeds when agent state transitions to terminated without detach", () => {
    // Build a mutable agent mock so we can simulate termination
    const agentMut = makeAgent("term-agent") as import("@koi/core").Agent & {
      state: import("@koi/core").ProcessState;
    };
    const first = createDebugAttach({ agent: agentMut });
    expect(first.ok).toBe(true);

    // Simulate runtime termination of the agent — no session.detach() called
    agentMut.state = "terminated";

    // Re-attach should detect stale entry and succeed
    const second = createDebugAttach({ agent: agentMut });
    expect(second.ok).toBe(true);
    if (second.ok) second.value.session.detach();
  });
});

describe("hasDebugSession — liveness check", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("returns false for terminated agent even with stale registry entry", () => {
    const agent = makeAgent("term-check") as import("@koi/core").Agent & {
      state: import("@koi/core").ProcessState;
    };
    createDebugAttach({ agent });
    expect(hasDebugSession(agent.pid.id)).toBe(true);

    // Simulate agent termination without calling session.detach()
    agent.state = "terminated";
    expect(hasDebugSession(agent.pid.id)).toBe(false);
  });
});

describe("step() — intra-turn event-level stepping", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("pausing on tool_call_start and stepping stops at turn_end (not next turn)", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    // Set a breakpoint on tool_call_start
    session.breakOn({ kind: "event_kind", eventKind: "tool_call_start" });

    const fakeRequest: import("@koi/core").ToolRequest = { toolId: "my_tool", input: {} };
    const fakeNext = async (r: import("@koi/core").ToolRequest) =>
      ({ toolId: r.toolId, output: "done" }) as import("@koi/core").ToolResponse;

    // Fire a tool call — pauses at tool_call_start
    const callPromise = middleware.wrapToolCall?.(
      { turnIndex: 0 } as import("@koi/core").TurnContext,
      fakeRequest,
      fakeNext,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state().kind).toBe("paused");

    // Step from intra-turn pause — installs turn_end BP, releases gate
    session.step();
    // wrapToolCall completes (tool_call_end + tool_result don't have BPs)
    await callPromise;
    expect(session.state().kind).toBe("attached"); // not paused mid-call

    // Fire turn_end — should pause on the step-event turn_end BP
    const turnEndPromise = middleware.onAfterTurn?.({
      turnIndex: 0,
    } as import("@koi/core").TurnContext);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state().kind).toBe("paused"); // paused at turn boundary

    session.resume();
    await turnEndPromise;
  });
});

describe("session.detach() uniformly revokes all methods", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("all public session methods are revoked after detach", () => {
    const agent = makeAgent();
    (agent.components() as Map<string, unknown>).set("test:data", [1, 2]);
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session } = result.value;

    session.detach();

    expect(() => session.inspect()).toThrow("detached");
    expect(() => session.breakOn({ kind: "turn" })).toThrow("detached");
    expect(session.removeBreakpoint("bp-1" as import("@koi/core").BreakpointId)).toBe(false);
    expect(session.events()).toHaveLength(0);
    expect(() => session.createObserver()).toThrow("detached");
  });

  test("stale-session replacement revokes the old session handle", () => {
    const agent = makeAgent("replace-me") as import("@koi/core").Agent & {
      state: import("@koi/core").ProcessState;
    };
    const first = createDebugAttach({ agent });
    if (!first.ok) return;
    const oldSession = first.value.session;

    // Simulate agent termination
    agent.state = "terminated";

    // Re-attach — stale old session should be detached
    const second = createDebugAttach({ agent });
    expect(second.ok).toBe(true);

    // Old session handle must be unusable now
    expect(() => oldSession.inspect()).toThrow("detached");
    if (second.ok) second.value.session.detach();
  });
});

describe("step() — stale step breakpoint cleanup", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("repeated step() calls do not accumulate step-target breakpoints", async () => {
    const agent = makeAgent();
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const { session, middleware } = result.value;

    session.breakOn({ kind: "turn", turnIndex: 0 });
    const pause0 = fireTurnStart(middleware, 0);
    await new Promise((r) => setTimeout(r, 0));

    // First step — installs step-target for turn 1
    session.step();
    // Paused cleared; no new pause until turn 1 — but we want to step again
    await pause0;

    // Re-pause at turn 1 via a fresh breakpoint so we can call step() again
    session.breakOn({ kind: "turn", turnIndex: 1 });
    const pause1 = fireTurnStart(middleware, 1);
    await new Promise((r) => setTimeout(r, 0));

    // Before second step: old step-target for turn 1 may still be armed;
    // step() must clean it up, leaving exactly one step-target for turn 2
    const snapshotBefore = await session.inspect();
    session.step();
    const snapshotAfter = await session.inspect();

    const stepTargetsAfter = snapshotAfter.breakpoints.filter((b) => b.label === "step-target");
    // After cleanup + new install, exactly one step-target must exist
    expect(stepTargetsAfter).toHaveLength(1);
    // Sanity: confirm we do not exceed the before count + 1
    expect(snapshotAfter.breakpoints.length).toBeLessThanOrEqual(
      snapshotBefore.breakpoints.length + 1,
    );

    session.resume();
    await pause1;
  });
});

describe("inspectComponent — pagination validation", () => {
  beforeEach(() => clearAllDebugSessions());
  afterEach(() => clearAllDebugSessions());

  test("rejects negative offset with VALIDATION error", () => {
    const agent = makeAgent();
    (agent.components() as Map<string, unknown>).set("test:arr", [1, 2, 3]);
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const snap = result.value.session.inspectComponent(
      "test:arr" as import("@koi/core").SubsystemToken<unknown>,
      { offset: -1, limit: 10 },
    );
    expect(snap.ok).toBe(false);
    if (snap.ok) return;
    expect(snap.error.code).toBe("VALIDATION");
  });

  test("rejects negative limit with VALIDATION error", () => {
    const agent = makeAgent();
    (agent.components() as Map<string, unknown>).set("test:arr", [1, 2, 3]);
    const result = createDebugAttach({ agent });
    if (!result.ok) return;
    const snap = result.value.session.inspectComponent(
      "test:arr" as import("@koi/core").SubsystemToken<unknown>,
      { offset: 0, limit: -5 },
    );
    expect(snap.ok).toBe(false);
    if (snap.ok) return;
    expect(snap.error.code).toBe("VALIDATION");
  });

  test("observer rejects non-integer offset with VALIDATION error", () => {
    const agent = makeAgent();
    (agent.components() as Map<string, unknown>).set("test:arr", [1, 2, 3]);
    createDebugAttach({ agent });
    const observeResult = createDebugObserve(agent.pid.id);
    if (!observeResult.ok) return;
    const snap = observeResult.value.inspectComponent(
      "test:arr" as import("@koi/core").SubsystemToken<unknown>,
      { offset: 1.5, limit: 10 },
    );
    expect(snap.ok).toBe(false);
    if (snap.ok) return;
    expect(snap.error.code).toBe("VALIDATION");
  });
});

describe("debug middleware phase", () => {
  test("debug middleware is in intercept phase to wrap auth/permission layers", () => {
    const { createDebugMiddleware } =
      require("./debug-middleware.js") as typeof import("./debug-middleware.js");
    const { createEventRingBuffer } =
      require("./event-ring-buffer.js") as typeof import("./event-ring-buffer.js");
    const buf = createEventRingBuffer(10);
    const { middleware } = createDebugMiddleware(buf);
    expect(middleware.phase).toBe("intercept");
  });
});
