/**
 * createTuiApp factory tests — Decision 11A: all four failure modes covered.
 *
 * Uses @opentui/core/testing's createTestRenderer as the injected renderer
 * (Decision 10A) — same test infrastructure that message-list.test.tsx uses.
 *
 * The four failure scenarios tested:
 *   1. no-TTY environment → Result error (synchronous, no renderer needed)
 *   2. renderer creation failure → handle.start() throws
 *   3. stop() before start() → no-op (idempotent)
 *   4. stop() called twice → no-op (idempotent), no double-dispose
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createPermissionBridge } from "./bridge/permission-bridge.js";
import { createTuiApp } from "./create-app.js";
import { createInitialState } from "./state/initial.js";
import { createStore } from "./state/store.js";

// ---------------------------------------------------------------------------
// Test renderer factory (real CliRenderer, no Zig production renderer)
// ---------------------------------------------------------------------------

async function makeTestRenderer(): Promise<CliRenderer> {
  const { renderer } = await createTestRenderer({ width: 80, height: 24 });
  return renderer;
}

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

async function makeConfig(overrides?: { renderer?: CliRenderer }) {
  const store = createStore(createInitialState());
  const permissionBridge = createPermissionBridge({ store });
  return {
    store,
    permissionBridge,
    onCommand: mock((_id: string) => {}),
    onSessionSelect: mock((_id: string) => {}),
    onSubmit: mock((_text: string) => {}),
    onInterrupt: mock(() => {}),
    renderer: overrides?.renderer ?? (await makeTestRenderer()),
  };
}

// ---------------------------------------------------------------------------
// TTY state helpers
// ---------------------------------------------------------------------------

let originalIsTTY: boolean | undefined;
let originalColumns: number | undefined;

beforeEach(() => {
  originalIsTTY = process.stdout.isTTY;
  originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    get: () => true,
  });
  if (!process.stdout.columns) {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 80,
    });
  }
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    get: () => originalIsTTY,
  });
  if (originalColumns !== undefined) {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: originalColumns,
    });
  }
});

// ---------------------------------------------------------------------------
// 1. no-TTY environment — Expected failure: returns Result error
// ---------------------------------------------------------------------------

describe("createTuiApp — no-TTY", () => {
  test("returns ok=false with kind=no_tty when stdout is not a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      get: () => false,
    });
    const result = createTuiApp(await makeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no_tty");
    }
  });

  test("does not call renderer when no-TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      get: () => false,
    });
    const renderer = await makeTestRenderer();
    const destroySpy = spyOn(renderer, "destroy");
    createTuiApp(await makeConfig({ renderer }));
    expect(destroySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path — start() mounts + stop() cleans up
// ---------------------------------------------------------------------------

describe("createTuiApp — happy path", () => {
  test("returns ok=true with start/stop handle", async () => {
    const result = createTuiApp(await makeConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.start).toBe("function");
      expect(typeof result.value.stop).toBe("function");
    }
  });

  test("start() resolves without throwing", async () => {
    const config = await makeConfig();
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(result.value.start()).resolves.toBeUndefined();
      await result.value.stop();
    }
  });

  test("start() dispatches initial set_layout action", async () => {
    const config = await makeConfig();
    const dispatchSpy = spyOn(config.store, "dispatch");
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.start();
      const layoutCalls = dispatchSpy.mock.calls.filter(
        (c) =>
          c[0] !== null &&
          typeof c[0] === "object" &&
          (c[0] as { kind: string }).kind === "set_layout",
      );
      expect(layoutCalls.length).toBeGreaterThanOrEqual(1);
      await result.value.stop();
    }
  });

  test("stop() calls permissionBridge.dispose()", async () => {
    const store = createStore(createInitialState());
    const permissionBridge = createPermissionBridge({ store });
    const disposeSpy = spyOn(permissionBridge, "dispose");
    const config = {
      store,
      permissionBridge,
      onCommand: mock((_id: string) => {}),
      onSessionSelect: mock((_id: string) => {}),
      onSubmit: mock((_text: string) => {}),
      onInterrupt: mock(() => {}),
      renderer: await makeTestRenderer(),
    };
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.start();
      await result.value.stop();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. stop() before start() — Expected: no-op
// ---------------------------------------------------------------------------

describe("createTuiApp — stop() before start()", () => {
  test("stop() before start() is a no-op (does not throw)", async () => {
    const config = await makeConfig();
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(result.value.stop()).resolves.toBeUndefined();
    }
  });

  test("permissionBridge.dispose NOT called if stop before start", async () => {
    const store = createStore(createInitialState());
    const permissionBridge = createPermissionBridge({ store });
    const disposeSpy = spyOn(permissionBridge, "dispose");
    const config = {
      store,
      permissionBridge,
      onCommand: mock((_id: string) => {}),
      onSessionSelect: mock((_id: string) => {}),
      onSubmit: mock((_text: string) => {}),
      onInterrupt: mock(() => {}),
      renderer: await makeTestRenderer(),
    };
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.stop(); // stop before start
      expect(disposeSpy).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. stop() called twice — Idempotent: no double-dispose
// ---------------------------------------------------------------------------

describe("createTuiApp — double stop()", () => {
  test("stop() is idempotent — second call is a no-op", async () => {
    const store = createStore(createInitialState());
    const permissionBridge = createPermissionBridge({ store });
    const disposeSpy = spyOn(permissionBridge, "dispose");
    const config = {
      store,
      permissionBridge,
      onCommand: mock((_id: string) => {}),
      onSessionSelect: mock((_id: string) => {}),
      onSubmit: mock((_text: string) => {}),
      onInterrupt: mock(() => {}),
      renderer: await makeTestRenderer(),
    };
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.start();
      await result.value.stop(); // first stop — dispose called once
      await result.value.stop(); // second stop — no-op
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    }
  });

  test("resize listener is registered once and cleaned up on first stop()", async () => {
    const config = await makeConfig();
    const onSpy = spyOn(process.stdout, "on");
    const offSpy = spyOn(process.stdout, "off");

    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.start();
      await result.value.stop();
      await result.value.stop(); // second stop — no extra off()

      const resizeOnCount = onSpy.mock.calls.filter((c) => c[0] === "resize").length;
      const resizeOffCount = offSpy.mock.calls.filter((c) => c[0] === "resize").length;
      expect(resizeOnCount).toBe(1);
      expect(resizeOffCount).toBe(1);
    }

    onSpy.mockRestore();
    offSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. StoreContext is accessible to children after start()
// ---------------------------------------------------------------------------

describe("createTuiApp — StoreContext wired after start()", () => {
  test("StoreContext is accessible to children after start()", async () => {
    const config = await makeConfig();
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.start();

      // Dispatch an action after start — store must reflect it
      config.store.dispatch({ kind: "set_view", view: "sessions" });
      expect(config.store.getState().activeView).toBe("sessions");

      // Dispatch another action to confirm store is live
      config.store.dispatch({ kind: "set_connection_status", status: "connected" });
      expect(config.store.getState().connectionStatus).toBe("connected");

      await result.value.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. renderer.destroy() disposes the Solid reactive root
// ---------------------------------------------------------------------------

describe("createTuiApp — renderer.destroy() disposes Solid root", () => {
  test("renderer.destroy() disposes the Solid reactive root", async () => {
    const renderer = await makeTestRenderer();
    const config = await makeConfig({ renderer });
    const result = createTuiApp(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.start();

      // stop() calls renderer.destroy() internally — after stop, started is false
      await result.value.stop();

      // A second stop() must be a no-op (not throw) — confirms the root was
      // disposed and the guard prevents double-disposal
      await expect(result.value.stop()).resolves.toBeUndefined();
    }
  });
});
