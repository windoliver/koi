import { describe, expect, test } from "bun:test";
import { createStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import { createKeyboardHandler, type KeyboardCallbacks } from "./tui-keyboard.js";

function makeCallbacks(): KeyboardCallbacks & {
  readonly calls: readonly string[];
} {
  const mutableCalls: string[] = [];
  return {
    get calls() {
      return mutableCalls;
    },
    togglePalette: () => {
      mutableCalls.push("togglePalette");
    },
    refreshAgents: () => {
      mutableCalls.push("refreshAgents");
    },
    openInBrowser: () => {
      mutableCalls.push("openInBrowser");
    },
    stop: () => {
      mutableCalls.push("stop");
    },
    cancelAndGoBack: () => {
      mutableCalls.push("cancelAndGoBack");
    },
    closeSessions: () => {
      mutableCalls.push("closeSessions");
    },
    closeDataSources: () => {
      mutableCalls.push("closeDataSources");
    },
    dataSourceUp: () => {
      mutableCalls.push("dataSourceUp");
    },
    dataSourceDown: () => {
      mutableCalls.push("dataSourceDown");
    },
    dataSourceApprove: () => {
      mutableCalls.push("dataSourceApprove");
    },
    dataSourceSchema: () => {
      mutableCalls.push("dataSourceSchema");
    },
  };
}

describe("createKeyboardHandler", () => {
  test("Ctrl+P toggles palette", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x10");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["togglePalette"]);
  });

  test("Ctrl+R refreshes agents", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x12");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["refreshAgents"]);
  });

  test("Ctrl+O opens browser", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x0F");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["openInBrowser"]);
  });

  test("q quits when in agents view", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    // Default view is "agents"
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("q");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["stop"]);
  });

  test("q does not quit when in console view", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "console" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("q");
    expect(consumed).toBe(false);
    expect(cbs.calls).toEqual([]);
  });

  test("Escape goes back from console view", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "console" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x1b");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["cancelAndGoBack"]);
  });

  test("Escape does nothing in agents view", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x1b");
    expect(consumed).toBe(false);
    expect(cbs.calls).toEqual([]);
  });

  test("Escape closes palette", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "palette" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x1b");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["togglePalette"]);
  });

  test("Escape closes sessions view", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "sessions" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x1b");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["closeSessions"]);
  });

  test("Escape closes datasources view", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "datasources" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    const consumed = handler("\x1b");
    expect(consumed).toBe(true);
    expect(cbs.calls).toEqual(["closeDataSources"]);
  });

  test("arrow keys navigate datasources", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "datasources" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    expect(handler("\x1b[A")).toBe(true);
    expect(handler("\x1b[B")).toBe(true);
    expect(cbs.calls).toEqual(["dataSourceUp", "dataSourceDown"]);
  });

  test("a and s keys trigger datasource actions", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_view", view: "datasources" });
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    expect(handler("a")).toBe(true);
    expect(handler("s")).toBe(true);
    expect(cbs.calls).toEqual(["dataSourceApprove", "dataSourceSchema"]);
  });

  test("unrecognized keys return false", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    expect(handler("a")).toBe(false);
    expect(handler("z")).toBe(false);
    expect(handler("\x01")).toBe(false);
    expect(cbs.calls).toEqual([]);
  });
});
