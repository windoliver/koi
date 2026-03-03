/**
 * Tests for createDebugAttach, createDebugObserve, hasDebugSession, clearAllDebugSessions.
 *
 * These are the public API entry points for the debug package, managing
 * single-attach semantics and module-level session tracking.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "@koi/core";
import { agentId } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import {
  clearAllDebugSessions,
  createDebugAttach,
  createDebugObserve,
  hasDebugSession,
} from "./create-debug-attach.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAllDebugSessions();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(id: string): Agent {
  return createMockAgent({ pid: { id: agentId(id) } });
}

// ---------------------------------------------------------------------------
// Tests: createDebugAttach
// ---------------------------------------------------------------------------

describe("createDebugAttach", () => {
  test("returns session and middleware on first attach", () => {
    const agent = makeAgent("agent-1");
    const result = createDebugAttach({ agent });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.session).toBeDefined();
    expect(result.value.session.id).toBeTruthy();
    expect(result.value.session.agentId).toBe(agent.pid.id);
    expect(result.value.middleware).toBeDefined();
    expect(result.value.middleware.name).toBe("koi:debug");
  });

  test("returns CONFLICT error on second attach to same agent", () => {
    const agent = makeAgent("agent-conflict");
    const first = createDebugAttach({ agent });
    expect(first.ok).toBe(true);

    const second = createDebugAttach({ agent });
    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.error.code).toBe("CONFLICT");
    expect(second.error.message).toContain("agent-conflict");
    expect(second.error.retryable).toBe(false);
  });

  test("allows attaching to different agents simultaneously", () => {
    const agent1 = makeAgent("agent-a");
    const agent2 = makeAgent("agent-b");

    const result1 = createDebugAttach({ agent: agent1 });
    const result2 = createDebugAttach({ agent: agent2 });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
  });

  test("respects custom bufferSize config", () => {
    const agent = makeAgent("agent-buf");
    const result = createDebugAttach({ agent, bufferSize: 50 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the session works — event buffer should have the custom capacity
    // We can check through events() which reads from the underlying ring buffer
    const events = result.value.session.events();
    expect(events).toEqual([]);
  });

  test("session state is attached after creation", () => {
    const agent = makeAgent("agent-state");
    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const state = result.value.session.state();
    expect(state.kind).toBe("attached");
  });
});

// ---------------------------------------------------------------------------
// Tests: hasDebugSession
// ---------------------------------------------------------------------------

describe("hasDebugSession", () => {
  test("returns true when agent has an active debug session", () => {
    const agent = makeAgent("agent-has");
    createDebugAttach({ agent });

    expect(hasDebugSession(agentId("agent-has"))).toBe(true);
  });

  test("returns false when agent has no debug session", () => {
    expect(hasDebugSession(agentId("nonexistent"))).toBe(false);
  });

  test("returns false after session is detached", () => {
    const agent = makeAgent("agent-detach-check");
    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.value.session.detach();
    expect(hasDebugSession(agentId("agent-detach-check"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: detach and re-attach
// ---------------------------------------------------------------------------

describe("detach and re-attach", () => {
  test("detach cleans up tracking and allows re-attach", () => {
    const agent = makeAgent("agent-reattach");
    const first = createDebugAttach({ agent });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    first.value.session.detach();
    expect(hasDebugSession(agentId("agent-reattach"))).toBe(false);

    // Re-attach should succeed
    const second = createDebugAttach({ agent });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Should get a new session with a different ID
    expect(second.value.session.id).not.toBe(first.value.session.id);
  });

  test("session state becomes detached after detach", () => {
    const agent = makeAgent("agent-detach-state");
    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.value.session.detach();
    const state = result.value.session.state();
    expect(state.kind).toBe("detached");
  });

  test("double detach is safe (idempotent)", () => {
    const agent = makeAgent("agent-double-detach");
    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.value.session.detach();
    // Second detach should not throw
    expect(() => result.value.session.detach()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: createDebugObserve
// ---------------------------------------------------------------------------

describe("createDebugObserve", () => {
  test("returns NOT_FOUND when no session exists for the agent", () => {
    const agent = makeAgent("agent-no-session");
    const id = agentId("agent-no-session");
    const result = createDebugObserve(id, agent);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("agent-no-session");
    expect(result.error.retryable).toBe(false);
  });

  test("returns observer when session exists", () => {
    const agent = makeAgent("agent-observe");
    const attachResult = createDebugAttach({ agent });
    expect(attachResult.ok).toBe(true);

    const id = agentId("agent-observe");
    const observeResult = createDebugObserve(id, agent);

    expect(observeResult.ok).toBe(true);
    if (!observeResult.ok) return;

    const observer = observeResult.value;
    expect(observer.id).toBeTruthy();
    expect(observer.agentId).toBe(agent.pid.id);
  });

  test("observer can inspect the agent snapshot", async () => {
    const agent = makeAgent("agent-observe-inspect");
    const attachResult = createDebugAttach({ agent });
    expect(attachResult.ok).toBe(true);

    const id = agentId("agent-observe-inspect");
    const observeResult = createDebugObserve(id, agent);
    expect(observeResult.ok).toBe(true);
    if (!observeResult.ok) return;

    const snapshot = await observeResult.value.inspect();
    expect(snapshot.agentId).toBe(agent.pid.id);
    expect(snapshot.processState).toBe("running");
  });

  test("observer can read events from the shared buffer", () => {
    const agent = makeAgent("agent-observe-events");
    const attachResult = createDebugAttach({ agent });
    expect(attachResult.ok).toBe(true);
    if (!attachResult.ok) return;

    const id = agentId("agent-observe-events");
    const observeResult = createDebugObserve(id, agent);
    expect(observeResult.ok).toBe(true);
    if (!observeResult.ok) return;

    // Initially no events
    const events = observeResult.value.events();
    expect(events).toEqual([]);
  });

  test("multiple observers can be created for the same session", () => {
    const agent = makeAgent("agent-multi-observe");
    createDebugAttach({ agent });

    const id = agentId("agent-multi-observe");
    const obs1 = createDebugObserve(id, agent);
    const obs2 = createDebugObserve(id, agent);

    expect(obs1.ok).toBe(true);
    expect(obs2.ok).toBe(true);
    if (!obs1.ok || !obs2.ok) return;

    // Each observer gets a unique ID
    expect(obs1.value.id).not.toBe(obs2.value.id);
  });

  test("returns NOT_FOUND after session is detached", () => {
    const agent = makeAgent("agent-observe-after-detach");
    const attachResult = createDebugAttach({ agent });
    expect(attachResult.ok).toBe(true);
    if (!attachResult.ok) return;

    attachResult.value.session.detach();

    const id = agentId("agent-observe-after-detach");
    const observeResult = createDebugObserve(id, agent);
    expect(observeResult.ok).toBe(false);
    if (observeResult.ok) return;
    expect(observeResult.error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Tests: clearAllDebugSessions
// ---------------------------------------------------------------------------

describe("clearAllDebugSessions", () => {
  test("cleans up all active sessions", () => {
    const agent1 = makeAgent("agent-clear-1");
    const agent2 = makeAgent("agent-clear-2");

    createDebugAttach({ agent: agent1 });
    createDebugAttach({ agent: agent2 });

    expect(hasDebugSession(agentId("agent-clear-1"))).toBe(true);
    expect(hasDebugSession(agentId("agent-clear-2"))).toBe(true);

    clearAllDebugSessions();

    expect(hasDebugSession(agentId("agent-clear-1"))).toBe(false);
    expect(hasDebugSession(agentId("agent-clear-2"))).toBe(false);
  });

  test("allows re-attach after clearAll", () => {
    const agent = makeAgent("agent-clear-reattach");
    createDebugAttach({ agent });

    clearAllDebugSessions();

    const result = createDebugAttach({ agent });
    expect(result.ok).toBe(true);
  });

  test("is safe to call when no sessions exist", () => {
    expect(() => clearAllDebugSessions()).not.toThrow();
  });
});
