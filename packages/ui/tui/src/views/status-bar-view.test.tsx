/**
 * Tests for StatusBarView — OpenTUI component rendering.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { testRender } from "@opentui/solid";
import { createStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import { createStoreSignal } from "./store-bridge.js";
import { StatusBarView } from "./status-bar-view.js";

function makeStore() {
  return createStore(createInitialState("http://localhost:3100"));
}

describe("StatusBarView", () => {
  test("renders KOI branding", async () => {
    const store = makeStore();
    const { captureCharFrame, renderOnce } = await testRender(() => {
      const state = createStoreSignal(store);
      return StatusBarView({ state });
    }, { width: 100, height: 3 });

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("KOI");
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

    const { captureCharFrame, renderOnce } = await testRender(() => {
      const state = createStoreSignal(store);
      return StatusBarView({ state });
    }, { width: 100, height: 3 });

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("2 agents");
  });

  test("shows connection status indicator", async () => {
    const store = makeStore();
    store.dispatch({ kind: "set_connection_status", status: "connected" });

    const { captureCharFrame, renderOnce } = await testRender(() => {
      const state = createStoreSignal(store);
      return StatusBarView({ state });
    }, { width: 100, height: 3 });

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("●");
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

    const { captureCharFrame, renderOnce } = await testRender(() => {
      const state = createStoreSignal(store);
      return StatusBarView({ state });
    }, { width: 100, height: 3 });

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("my-agent");
  });

  test("shows keyboard hints for agents view", async () => {
    const store = makeStore();
    const { captureCharFrame, renderOnce } = await testRender(() => {
      const state = createStoreSignal(store);
      return StatusBarView({ state });
    }, { width: 120, height: 3 });

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("navigate");
  });
});
