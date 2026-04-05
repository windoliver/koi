/**
 * createTuiApp — factory for the @koi/tui application.
 *
 * Architecture decisions:
 * - 4A: Auto-mount; returns TuiAppHandle with start()/stop().
 * - 8A: Returns Result<TuiAppHandle, TuiStartError> for no-TTY (expected failure).
 *       Throws Error with cause for renderer failure (unexpected — Zig FFI init).
 * - 10A: config.renderer optional — injected in tests, created internally in prod.
 * - 15A: 16ms debounce on resize dispatch — one render-frame, collapses drag bursts.
 * - 2A: createTuiApp installs the resize listener + dispatches set_layout.
 *
 * Solid render note: @opentui/solid's render() hooks renderer.destroy() to
 * automatically dispose the Solid reactive root. stop() calls renderer.destroy()
 * which triggers that cleanup — no separate unmount step needed.
 */

import type { Result } from "@koi/core/errors";
// `createCliRenderer` uses a native Zig FFI library — lazy-import it inside
// start() so tests with an injected renderer never load the native binary.
import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import type { PermissionBridge } from "./bridge/permission-bridge.js";
import type { TuiStore } from "./state/store.js";
import { StoreContext } from "./store-context.js";
import { computeLayoutTier } from "./theme.js";
import { TuiRoot } from "./tui-root.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Expected startup failure returned as a typed Result, never thrown. */
export type TuiStartError = { readonly kind: "no_tty" };

/** Lifecycle handle returned by createTuiApp on success. */
export interface TuiAppHandle {
  /** Mount the renderer and start rendering. Throws on unexpected renderer failure. */
  readonly start: () => Promise<void>;
  /** Unmount, destroy renderer, restore stdin. Idempotent — safe to call multiple times. */
  readonly stop: () => Promise<void>;
  /**
   * Returns a Promise that resolves when the *current* stop() completes.
   * Each start() creates a fresh deferred — safe to call across restarts.
   * Await this after start() to keep the process alive until the TUI exits.
   * Never rejects — stop() catches all errors internally.
   * Returns an already-resolved Promise when no run is active.
   */
  readonly done: () => Promise<void>;
}

/** Configuration for createTuiApp. */
export interface CreateTuiAppConfig {
  /** Pre-created TUI state store. */
  readonly store: TuiStore;
  /** Permission bridge for tool approval prompts. */
  readonly permissionBridge: PermissionBridge;
  /** Called when the user selects a command from the palette. */
  readonly onCommand: (commandId: string) => void;
  /** Called when the user selects a session to resume. */
  readonly onSessionSelect: (sessionId: string) => void;
  /** Called when the user submits a message. */
  readonly onSubmit: (text: string) => void;
  /** Called when the user triggers Ctrl+C interrupt. */
  readonly onInterrupt: () => void;
  /**
   * Optional renderer for testing (Decision 10A).
   * When provided, createTuiApp uses it directly instead of calling createCliRenderer().
   * The injected renderer is NOT destroyed on stop() — the caller owns its lifecycle.
   */
  readonly renderer?: CliRenderer | undefined;
  readonly screenMode?: "split-footer" | undefined;
  readonly footerHeight?: number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TUI application handle.
 *
 * Returns `{ ok: false, error: { kind: "no_tty" } }` when stdout is not a TTY
 * (CI, pipe, file redirection, etc.).
 *
 * Call `handle.start()` to mount and begin rendering.
 * Call `handle.stop()` to clean up. It is safe to call stop() before start()
 * and to call stop() multiple times.
 */
export function createTuiApp(config: CreateTuiAppConfig): Result<TuiAppHandle, TuiStartError> {
  // Decision 8A: TTY check is an expected failure — return Result, not throw
  if (!process.stdout.isTTY) {
    return { ok: false, error: { kind: "no_tty" } };
  }

  const {
    store,
    permissionBridge,
    onCommand,
    onSessionSelect,
    onSubmit,
    onInterrupt,
    renderer: injectedRenderer,
    screenMode,
    footerHeight,
  } = config;

  let started = false;
  // Set by stop() to cancel any in-flight start(). start() checks this after
  // each async boundary so a stopped handle can never re-animate.
  let closing = false;
  // Per-run deferred: created by start(), resolved by stop().
  // Null when no run is active (done() returns Promise.resolve() in that case).
  let currentDoneResolve: (() => void) | null = null;
  let currentDone: Promise<void> = Promise.resolve();
  // Monotonically incremented by every stop() call. Each start() captures the
  // generation at launch; if the generation changes by the time start() reaches
  // the mount step, it self-aborts — even if closing was reset after a timeout.
  let stopGeneration = 0;
  // In-flight startup promise — shared by concurrent start() calls so only
  // one initialization runs, and stop() can await it before tearing down.
  let startPromise: Promise<void> | null = null;
  let activeRenderer: CliRenderer | undefined;
  // Explicit event-loop keepalive held while the TUI is mounted. A pending
  // Promise alone does not prevent Bun/Node from exiting on beforeExit — only
  // a real runtime handle (timer, socket, etc.) does. Cleared by stop().
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupResize: (() => void) | undefined;
  // Declared as `let` — reassigned in the debounce closure; justified by design
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Explicit Solid reactive-root dispose captured during start() by intercepting
  // the renderer.once("destroy") registration that mountSolidRoot makes.
  // Called directly on stop() so we clean up without broadcasting a destroy event.
  let solidRootDispose: (() => void) | undefined;

  const handle: TuiAppHandle = {
    done(): Promise<void> {
      return currentDone;
    },

    async start(): Promise<void> {
      if (started) return; // already running
      if (closing) return; // stop() was called — handle is permanently closed
      if (startPromise !== null) return startPromise; // concurrent call — share init

      // Capture the current stop generation. If stop() is called while we are
      // awaiting renderer creation, the generation increments and we self-abort
      // at the mount step — even if closing was reset after a 5s timeout.
      const myGeneration = stopGeneration;

      const p: Promise<void> = (async (): Promise<void> => {
        // Resolve renderer before committing `started` so a failure leaves the
        // handle in a retryable clean state.
        let localRenderer: CliRenderer;
        if (injectedRenderer !== undefined) {
          localRenderer = injectedRenderer;
        } else {
          // Lazy import — only loads the Zig FFI binary when actually needed.
          // Tests with an injected renderer never reach this branch.
          try {
            const { createCliRenderer } = await import("@opentui/core");
            localRenderer =
              screenMode === "split-footer"
                ? await createCliRenderer({
                    exitOnCtrlC: false,
                    screenMode,
                    ...(footerHeight !== undefined ? { footerHeight } : {}),
                  })
                : await createCliRenderer({ exitOnCtrlC: false });
          } catch (e: unknown) {
            throw new Error("Failed to start TUI renderer", { cause: e });
          }
        }

        // Check cancellation after the async renderer creation.
        // Two conditions: `closing` (stop() in progress) OR `stopGeneration`
        // changed (stop() completed and reset closing, but this start() is stale).
        if (closing || stopGeneration !== myGeneration) {
          if (localRenderer !== injectedRenderer) {
            try {
              localRenderer.destroy();
            } catch {
              /* ignore */
            }
          }
          return;
        }

        // Decision 2A: dispatch initial layout tier before first render
        const dispatchLayout = (): void => {
          const cols = process.stdout.columns ?? 80;
          store.dispatch({ kind: "set_layout", tier: computeLayoutTier(cols) });
        };
        dispatchLayout();

        // Decision 15A: 16ms debounce — collapses 60+ resize events/sec to 1-2 per frame
        const onResize = (): void => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout((): void => {
            dispatchLayout();
            debounceTimer = null;
          }, 16);
        };
        process.stdout.on("resize", onResize);
        cleanupResize = (): void => {
          process.stdout.off("resize", onResize);
          if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
        };

        // Commit renderer and mark started.
        activeRenderer = localRenderer;
        started = true;

        // Decision 4A: auto-mount the Solid component tree.
        // createComponent is Solid's non-JSX API (identical to compiled JSX output).
        //
        // @opentui/solid's mountSolidRoot registers a one-time "destroy" listener
        // on the renderer to dispose the Solid reactive root. We intercept that
        // registration to capture the dispose function directly, so stop() can
        // call it without broadcasting the renderer's public "destroy" event to
        // other listeners (which would incorrectly signal renderer destruction to
        // caller-owned renderers).
        const rendererForCapture = activeRenderer;
        const originalOnce = rendererForCapture.once.bind(rendererForCapture);
        rendererForCapture.once = (
          event: string,
          listener: (...args: unknown[]) => void,
        ): typeof rendererForCapture => {
          if (event === "destroy" && solidRootDispose === undefined) {
            solidRootDispose = listener as () => void;
          }
          return originalOnce(event, listener);
        };

        // If render throws, roll back all committed state so the handle is retryable.
        try {
          await render(
            () =>
              createComponent(StoreContext.Provider, {
                value: store,
                get children() {
                  // TuiRoot creates TuiStateContext.Provider internally, so
                  // only StoreContext.Provider is needed at this level.
                  return createComponent(TuiRoot, {
                    onCommand,
                    onSessionSelect,
                    onSubmit,
                    onInterrupt,
                    onPermissionRespond: permissionBridge.respond,
                  });
                },
              }),
            activeRenderer,
          );
        } catch (e: unknown) {
          // Roll back everything committed above.
          started = false;
          solidRootDispose = undefined;
          cleanupResize?.();
          cleanupResize = undefined;
          if (localRenderer !== injectedRenderer) {
            try {
              localRenderer.destroy();
            } catch {
              /* ignore secondary error */
            }
          }
          activeRenderer = undefined;
          throw e;
        } finally {
          // Always restore once() — we only needed it during mount
          rendererForCapture.once = originalOnce;
        }

        // Mount succeeded — create a fresh per-run deferred so each start/stop
        // cycle gets its own completion signal (handles are restartable).
        currentDone = new Promise<void>((resolve) => {
          currentDoneResolve = resolve;
        });

        // Hold the event loop open. A pending Promise does not prevent
        // Bun/Node from exiting on beforeExit — only a real handle does.
        // The renderer "destroy" listener below clears this timer if the renderer
        // dies externally, so the timer does not pin the process indefinitely.
        keepAliveTimer = setInterval(() => {}, 2_147_483_647);

        // If the renderer is destroyed externally (crash, OS teardown) without
        // stop() being called, resolve done() and release the keepalive so the
        // process is not pinned by a synthetic timer with no live renderer.
        // Uses the restored `once` (not the capture shim) — mount is complete.
        activeRenderer.once("destroy", (): void => {
          if (keepAliveTimer !== null) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
          currentDoneResolve?.();
          currentDoneResolve = null;
          currentDone = Promise.resolve();
          started = false;
        });

        // Guard: if stop() already ran and timed out during the mount (stop
        // timeout fired while render() was awaiting native FFI init), it
        // returned without resolving currentDone because currentDoneResolve was
        // null at the time. Resolve and release the keepalive now so the
        // process can exit cleanly.
        if (stopGeneration !== myGeneration) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
          currentDoneResolve?.();
          currentDoneResolve = null;
          currentDone = Promise.resolve();
        }
      })();

      startPromise = p;
      try {
        await p;
      } finally {
        // Clear the in-flight promise so a failed start can be retried and
        // stop() can detect that startup has fully settled.
        if (startPromise === p) startPromise = null;
      }
    },

    async stop(): Promise<void> {
      // True no-op if nothing has started or is starting — preserves the
      // stop-before-start contract and restartability.
      if (!started && startPromise === null) return;

      // Signal cancellation so any in-flight start() aborts after its next
      // async boundary — prevents re-animation after shutdown.
      // Incrementing stopGeneration ensures that even if closing is reset after
      // the 5s timeout, a late-completing start() will self-abort when it checks
      // its captured generation against the current value.
      closing = true;
      stopGeneration++;

      // Dispose the bridge immediately — it resolves pending approvals with
      // deny. Safe to call before start() completes and idempotent on repeat.
      permissionBridge.dispose();

      // If startup is in progress, wait for it to settle — but not forever.
      // Native FFI init can stall; 5 s covers normal startup and lets us do
      // best-effort cleanup rather than hanging the process on a stuck renderer.
      if (startPromise !== null) {
        const STOP_TIMEOUT_MS = 5_000;
        await Promise.race([
          startPromise.catch(() => {}), // swallow — checked via `started` below
          new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
        ]);
      }

      if (!started) {
        // Startup was cancelled, failed, or timed out — reset closing so the
        // handle can be started again after a transient failure.
        closing = false;
        return;
      }
      started = false;
      closing = false; // reset so the handle is restartable

      cleanupResize?.();
      cleanupResize = undefined;

      // Dispose the Solid reactive root (releases store subscriptions, keyboard
      // hooks, etc.). We captured the dispose function during start() by
      // intercepting mountSolidRoot's renderer.once("destroy") registration.
      // Calling it directly avoids broadcasting the renderer's "destroy" event
      // to other listeners, which would incorrectly signal terminal destruction
      // to caller-owned renderers.
      solidRootDispose?.();
      solidRootDispose = undefined;

      // Only destroy the terminal renderer if we own it. renderer.destroy() also
      // fires "destroy" event, but solidRootDispose is already cleared above so
      // it won't be called twice (mountSolidRoot's once() listener is idempotent).
      if (activeRenderer !== undefined && injectedRenderer === undefined) {
        activeRenderer.destroy();
      }
      activeRenderer = undefined;

      // Release the event-loop keepalive before resolving done() so the process
      // can exit normally once all other handles (stdin, timers) are drained.
      if (keepAliveTimer !== null) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      // Resolve the per-run deferred — unblocks callers awaiting handle.done().
      currentDoneResolve?.();
      currentDoneResolve = null;
      currentDone = Promise.resolve();
    },
  };

  return { ok: true, value: handle };
}
