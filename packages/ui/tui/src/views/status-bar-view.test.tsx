/**
 * Tests for StatusBarView — OpenTUI React component rendering.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { testRender } from "@opentui/react/test-utils";
import { createStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import { StatusBarView } from "./status-bar-view.js";

function makeStore() {
  return createStore(createInitialState("http://localhost:3100"));
}

describe("StatusBarView", () => {
  test("renders KOI branding", async () => {
    const store = makeStore();
    const state = store.getState();
    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 100, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("NORMAL");
  });

  test("shows agent count", async () => {
    const store = makeStore();
    store.dispatch({
      kind: "set_agents",
      agents: [
        { agentId: agentId("a1"), name: "alpha", agentType: "worker" as const, state: "running" as const, model: "gpt-4", channels: [], turns: 3, startedAt: Date.now(), lastActivityAt: Date.now() },
        { agentId: agentId("a2"), name: "beta", agentType: "worker" as const, state: "idle" as const, model: "gpt-4", channels: [], turns: 1, startedAt: Date.now(), lastActivityAt: Date.now() },
      ],
    });

    const state = store.getState();
    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 100, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("2 agents");
  });

  test("shows connection status indicator", async () => {
    const store = makeStore();
    store.dispatch({ kind: "set_connection_status", status: "connected" });

    const state = store.getState();
    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 100, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("\u25CF");
  });

  test("shows active agent name when in session", async () => {
    const store = makeStore();
    store.dispatch({
      kind: "set_agents",
      agents: [
        { agentId: agentId("a1"), name: "my-agent", agentType: "worker" as const, state: "running" as const, model: "gpt-4", channels: [], turns: 5, startedAt: Date.now(), lastActivityAt: Date.now() },
      ],
    });
    store.dispatch({
      kind: "set_session",
      session: { agentId: "a1", sessionId: "s1", messages: [], pendingText: "", isStreaming: false },
    });

    const state = store.getState();
    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 100, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("my-agent");
  });

  test("shows keyboard hints for agents view", async () => {
    const store = makeStore();
    const state = store.getState();
    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 120, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("navigate");
  });

  test("hides capability dots at compact width", async () => {
    const store = makeStore();
    const state = {
      ...store.getState(),
      layoutTier: "narrow" as const,
      cols: 80,
      capabilities: {
        nexus: true,
        temporal: false,
        scheduler: false,
        gateway: true,
        harness: false,
        taskboard: false,
        forge: false,
        governance: false,
      },
    };

    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 80, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("●");
  });

  test("shows task status when task board has items", async () => {
    const store = makeStore();
    const state = {
      ...store.getState(),
      taskBoardView: {
        ...store.getState().taskBoardView,
        snapshot: {
          nodes: [
            { taskId: "t1", label: "Task 1", status: "completed" },
            { taskId: "t2", label: "Task 2", status: "running" },
            { taskId: "t3", label: "Task 3", status: "pending" },
          ],
          edges: [],
          timestamp: Date.now(),
        },
      },
    };

    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 160, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Tasks:");
    expect(frame).toContain("1/3 done");
  });

  test("hides task status when task board is empty", async () => {
    const store = makeStore();
    const state = store.getState();

    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 120, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("Tasks:");
  });

  test("shows capability dots at full width", async () => {
    const store = makeStore();
    const state = {
      ...store.getState(),
      layoutTier: "full" as const,
      cols: 120,
      capabilities: {
        nexus: true,
        temporal: false,
        scheduler: false,
        gateway: true,
        harness: false,
        taskboard: false,
        forge: false,
        governance: false,
      },
    };

    const { captureCharFrame, renderOnce } = await testRender(
      <StatusBarView state={state} />,
      { width: 120, height: 3 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("●");
  });
});
