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
import {
  createPermissionRespondWithParserReset,
  createTuiApp,
  readStdinParserReset,
} from "./create-app.js";
import { __resetProfilingForTests } from "./profiling/integration.js";
import { resetProfiler } from "./profiling/profiler.js";
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

  test("does not start the profiling sampler on no-TTY (#1586)", async () => {
    // Regression: initProfiling() once ran before the TTY guard. If
    // KOI_TUI_PROFILE=1 was set, the sampler interval would keep a
    // non-TTY process alive indefinitely.
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      get: () => false,
    });
    const prevEnv = process.env.KOI_TUI_PROFILE;
    process.env.KOI_TUI_PROFILE = "1";
    try {
      const setIntervalSpy = spyOn(globalThis, "setInterval");
      const callsBefore = setIntervalSpy.mock.calls.length;
      createTuiApp(await makeConfig());
      expect(setIntervalSpy.mock.calls.length).toBe(callsBefore);
      setIntervalSpy.mockRestore();
    } finally {
      if (prevEnv === undefined) delete process.env.KOI_TUI_PROFILE;
      else process.env.KOI_TUI_PROFILE = prevEnv;
    }
  });

  test("createTuiApp() without start() does not arm profiling (#1586)", async () => {
    // Regression: initProfiling() previously ran during factory construction,
    // so a handle that was never start()ed left a live sampler interval.
    // Profiling is now bound to start() ownership.
    const prevEnv = process.env.KOI_TUI_PROFILE;
    process.env.KOI_TUI_PROFILE = "1";
    try {
      const setIntervalSpy = spyOn(globalThis, "setInterval");
      const callsBefore = setIntervalSpy.mock.calls.length;
      const result = createTuiApp(await makeConfig());
      expect(result.ok).toBe(true);
      // No start() — sampler must not be armed.
      expect(setIntervalSpy.mock.calls.length).toBe(callsBefore);
      setIntervalSpy.mockRestore();
    } finally {
      if (prevEnv === undefined) delete process.env.KOI_TUI_PROFILE;
      else process.env.KOI_TUI_PROFILE = prevEnv;
    }
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
// 6. stdinParser.reset() on permission-prompt dismissal (issue #1689)
// ---------------------------------------------------------------------------

describe("createPermissionRespondWithParserReset (#1689)", () => {
  test("calls bridge.respond then stdinParser.reset in order", () => {
    const resetMock = mock(() => {});
    const respondMock = mock((_id: string, _d: ApprovalDecisionShape) => {});
    const wrapped = createPermissionRespondWithParserReset({
      bridge: { respond: respondMock },
      renderer: { stdinParser: { reset: resetMock } },
    });

    wrapped("req-1", { kind: "allow" });

    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(respondMock).toHaveBeenCalledWith("req-1", { kind: "allow" });
    expect(resetMock).toHaveBeenCalledTimes(1);
    // Ordering invariant: respond dispatches the reducer action (clears the
    // modal) before reset fires, so focus has already returned to the input.
    const respondOrder = respondMock.mock.invocationCallOrder[0];
    const resetOrder = resetMock.mock.invocationCallOrder[0];
    expect(respondOrder).toBeDefined();
    expect(resetOrder).toBeDefined();
    if (respondOrder !== undefined && resetOrder !== undefined) {
      expect(respondOrder).toBeLessThan(resetOrder);
    }
  });

  test("covers every ApprovalDecision variant", () => {
    const resetMock = mock(() => {});
    const respondMock = mock((_id: string, _d: ApprovalDecisionShape) => {});
    const wrapped = createPermissionRespondWithParserReset({
      bridge: { respond: respondMock },
      renderer: { stdinParser: { reset: resetMock } },
    });

    const decisions: readonly ApprovalDecisionShape[] = [
      { kind: "allow" },
      { kind: "always-allow", scope: "session" },
      { kind: "deny", reason: "user-dismissed" },
      { kind: "modify", updatedInput: { path: "override.txt" } },
    ];
    for (const d of decisions) wrapped("req-x", d);

    expect(respondMock).toHaveBeenCalledTimes(decisions.length);
    expect(resetMock).toHaveBeenCalledTimes(decisions.length);
  });

  test("no-throw when stdinParser is null (parser not yet installed)", () => {
    const respondMock = mock((_id: string, _d: ApprovalDecisionShape) => {});
    const wrapped = createPermissionRespondWithParserReset({
      bridge: { respond: respondMock },
      renderer: { stdinParser: null },
    });

    expect(() => wrapped("req-1", { kind: "allow" })).not.toThrow();
    expect(respondMock).toHaveBeenCalledTimes(1);
  });
});

describe("readStdinParserReset (#1689)", () => {
  test("returns a reset-bound helper when the renderer exposes stdinParser.reset", async () => {
    const renderer = await makeTestRenderer();
    const handle = readStdinParserReset(renderer);
    expect(handle).not.toBeNull();
    if (handle === null) return;
    expect(typeof handle.reset).toBe("function");
    // Invoking the helper must not throw — exercises the Reflect.get + call path.
    expect(() => handle.reset()).not.toThrow();
  });
});

// Narrow structural alias so the tests don't depend on @koi/core types.
type ApprovalDecisionShape =
  | { readonly kind: "allow" }
  | { readonly kind: "always-allow"; readonly scope: "session" | "always" }
  | { readonly kind: "modify"; readonly updatedInput: Record<string, unknown> }
  | { readonly kind: "deny"; readonly reason: string };

// ---------------------------------------------------------------------------
// 7. renderer.destroy() disposes the Solid reactive root
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

  test("external renderer destroy releases profiling ownership so a restart is accepted (#1586)", async () => {
    const prevEnv = process.env.KOI_TUI_PROFILE;
    const prevOut = process.env.KOI_TUI_PROFILE_OUT;
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = "/tmp/koi-1586-restart.json";
    __resetProfilingForTests();
    resetProfiler();

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      // Run 1: start, then crash via external renderer destroy (no stop()).
      const renderer1 = await makeTestRenderer();
      const result1 = createTuiApp(await makeConfig({ renderer: renderer1 }));
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;
      await result1.value.start();
      // Synchronous "destroy" emit — fires the externalDestroyHandler that
      // must release profiling ownership.
      renderer1.destroy();

      // Run 2: should take fresh ownership without the "already being
      // profiled" warning. If externalDestroyHandler did not release
      // profiling, this would fail.
      const renderer2 = await makeTestRenderer();
      const result2 = createTuiApp(await makeConfig({ renderer: renderer2 }));
      expect(result2.ok).toBe(true);
      if (!result2.ok) return;
      await result2.value.start();
      await result2.value.stop();

      const conflicts = stderrWrites.filter((w) => w.includes("already being profiled"));
      expect(conflicts.length).toBe(0);
    } finally {
      process.stderr.write = origWrite;
      __resetProfilingForTests();
      resetProfiler({ enabled: false });
      if (prevEnv === undefined) delete process.env.KOI_TUI_PROFILE;
      else process.env.KOI_TUI_PROFILE = prevEnv;
      if (prevOut === undefined) delete process.env.KOI_TUI_PROFILE_OUT;
      else process.env.KOI_TUI_PROFILE_OUT = prevOut;
    }
  });
});

// ---------------------------------------------------------------------------
// Critical store subscriber → fatal teardown wiring (#1940)
// ---------------------------------------------------------------------------

describe("createTuiApp — fatal critical-subscriber teardown", () => {
  test("critical subscriber failure triggers handle.stop() and chains to caller-supplied onFatal", async () => {
    const renderer = await makeTestRenderer();
    const stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    const callerOnFatal = mock((_e: Error) => {});
    try {
      const store = createStore(createInitialState(), { onFatal: callerOnFatal });
      const permissionBridge = createPermissionBridge({ store });
      const result = createTuiApp({
        store,
        permissionBridge,
        onCommand: mock(() => {}),
        onSessionSelect: mock(() => {}),
        onSubmit: mock(() => {}),
        onInterrupt: mock(() => {}),
        renderer,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const handle = result.value;
      const stopSpy = spyOn(handle, "stop");

      await handle.start();

      // Register a critical subscriber that throws on the next dispatch.
      const bad = mock(() => {
        throw new Error("renderer dead");
      });
      store.subscribe(bad, { critical: true });

      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      // Allow microtask + handle.stop's async chain to settle.
      await new Promise<void>((r) => setTimeout(r, 50));

      // createTuiApp's installed handler ran handle.stop() and chained to the
      // caller-supplied onFatal — both the renderer teardown and the broader
      // fatal callback fire (#1940).
      expect(stopSpy).toHaveBeenCalled();
      expect(callerOnFatal).toHaveBeenCalledTimes(1);
      expect(callerOnFatal.mock.calls[0]?.[0]?.message).toBe("renderer dead");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("failed start() unwinds the fatal handler so a retry against the same store is not poisoned", async () => {
    const stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    const callerOnFatal = mock((_e: Error) => {});
    try {
      const store = createStore(createInitialState(), { onFatal: callerOnFatal });
      const baseConfig = {
        store,
        permissionBridge: createPermissionBridge({ store }),
        onCommand: mock(() => {}),
        onSessionSelect: mock(() => {}),
        onSubmit: mock(() => {}),
        onInterrupt: mock(() => {}),
      };

      // First start fails: inject a renderer whose `once("destroy", ...)`
      // throws during the mount step in start(). This forces start() to
      // reject without ever reaching `started = true` or running stop().
      const failingRenderer = await makeTestRenderer();
      const originalOnce = failingRenderer.once.bind(failingRenderer);
      let armed = true;
      // biome-ignore lint/suspicious/noExplicitAny: test-only event-emitter override
      (failingRenderer as any).once = (event: string, listener: unknown): unknown => {
        if (armed && event === "destroy") {
          armed = false;
          throw new Error("once boom");
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwarding to original
        return originalOnce(event as any, listener as any);
      };

      const failed = createTuiApp({ ...baseConfig, renderer: failingRenderer });
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      await expect(failed.value.start()).rejects.toThrow();

      // Retry against the same store with a healthy renderer.
      const goodRenderer = await makeTestRenderer();
      const second = createTuiApp({ ...baseConfig, renderer: goodRenderer });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      await second.value.start();
      const secondStopSpy = spyOn(second.value, "stop");

      const bad = mock(() => {
        throw new Error("after-retry fail");
      });
      store.subscribe(bad, { critical: true });
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      await new Promise<void>((r) => setTimeout(r, 50));

      // Critical failure must reach exactly the live handle and the caller's
      // onFatal — the failed start's stale closure must not eat the event.
      expect(secondStopSpy).toHaveBeenCalled();
      expect(callerOnFatal).toHaveBeenCalledTimes(1);
      expect(callerOnFatal.mock.calls[0]?.[0]?.message).toBe("after-retry fail");
      await second.value.stop();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("stop() restores the previous fatal handler so a later run is unaffected", async () => {
    const renderer1 = await makeTestRenderer();
    const renderer2 = await makeTestRenderer();
    const stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    const callerOnFatal = mock((_e: Error) => {});
    try {
      const store = createStore(createInitialState(), { onFatal: callerOnFatal });
      const baseConfig = {
        store,
        permissionBridge: createPermissionBridge({ store }),
        onCommand: mock(() => {}),
        onSessionSelect: mock(() => {}),
        onSubmit: mock(() => {}),
        onInterrupt: mock(() => {}),
      };

      const first = createTuiApp({ ...baseConfig, renderer: renderer1 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await first.value.start();
      await first.value.stop();

      // After stop(), the disposed handle's fatal closure must NOT fire.
      // Trigger a critical failure with no live app — caller's onFatal runs
      // (the previous handler restored on stop), not first.value.stop().
      const second = createTuiApp({ ...baseConfig, renderer: renderer2 });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      await second.value.start();
      const secondStopSpy = spyOn(second.value, "stop");
      const firstStopSpy = spyOn(first.value, "stop");

      const bad = mock(() => {
        throw new Error("second-run fail");
      });
      store.subscribe(bad, { critical: true });
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      await new Promise<void>((r) => setTimeout(r, 50));

      // Second handle stops; first handle's stale closure does not.
      expect(secondStopSpy).toHaveBeenCalled();
      expect(firstStopSpy).not.toHaveBeenCalled();
      await second.value.stop();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
