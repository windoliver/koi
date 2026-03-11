/**
 * Tests for store-bridge — SolidJS reactive bridge for TuiStore.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createRoot } from "solid-js";
import { createStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import { createDerivedSignal, createStoreSignal } from "./store-bridge.js";

function makeStore() {
  return createStore(createInitialState("http://localhost:3100"));
}

describe("createStoreSignal", () => {
  test("returns initial state", () => {
    const store = makeStore();
    createRoot((dispose) => {
      const state = createStoreSignal(store);
      expect(state().view).toBe("agents");
      expect(state().agents).toEqual([]);
      expect(state().connectionStatus).toBe("disconnected");
      dispose();
    });
  });

  test("updates when store dispatches", () => {
    const store = makeStore();
    createRoot((dispose) => {
      const state = createStoreSignal(store);
      store.dispatch({ kind: "set_view", view: "console" });
      expect(state().view).toBe("console");
      dispose();
    });
  });

  test("unsubscribes on disposal", () => {
    const store = makeStore();
    let stateRef: ReturnType<typeof createStoreSignal> | null = null;
    createRoot((dispose) => {
      stateRef = createStoreSignal(store);
      expect(stateRef().view).toBe("agents");
      dispose();
    });
    // After disposal, dispatch should not throw
    store.dispatch({ kind: "set_view", view: "palette" });
    // stateRef still holds last known value before disposal
    expect(stateRef?.().view).toBe("agents");
  });
});

describe("createDerivedSignal", () => {
  test("extracts selected slice", () => {
    const store = makeStore();
    createRoot((dispose) => {
      const view = createDerivedSignal(store, (s) => s.view);
      expect(view()).toBe("agents");
      dispose();
    });
  });

  test("updates derived value on relevant dispatch", () => {
    const store = makeStore();
    createRoot((dispose) => {
      const connStatus = createDerivedSignal(store, (s) => s.connectionStatus);
      expect(connStatus()).toBe("disconnected");
      store.dispatch({ kind: "set_connection_status", status: "connected" });
      expect(connStatus()).toBe("connected");
      dispose();
    });
  });

  test("derives agent count", () => {
    const store = makeStore();
    createRoot((dispose) => {
      const count = createDerivedSignal(store, (s) => s.agents.length);
      expect(count()).toBe(0);
      store.dispatch({
        kind: "set_agents",
        agents: [
          {
            agentId: agentId("a1"),
            name: "agent-1",
            agentType: "worker" as const,
            state: "running" as const,
            model: "gpt-4",
            channels: [],
            turns: 5,
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        ],
      });
      expect(count()).toBe(1);
      dispose();
    });
  });
});
