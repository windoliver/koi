/**
 * createTuiApp — factory for the @koi/tui application.
 *
 * Architecture decisions:
 * - 4A: Auto-mount; returns TuiAppHandle with start()/stop().
 * - 8A: Returns Result<TuiAppHandle, TuiStartError> for no-TTY (expected failure).
 *       Throws Error with cause for renderer failure (unexpected — Zig FFI init).
 * - 10A: config.renderer optional — injected in tests, created internally in prod.
 * - 15A: 50ms debounce on resize dispatch to collapse rapid window-drag events.
 * - 2A: createTuiApp installs the resize listener + dispatches set_layout.
 */

import type { Result } from "@koi/core/errors";
// `createCliRenderer` uses a native Zig FFI library — lazy-import it inside
// start() so tests with an injected renderer never load the native binary.
import type { CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
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
  } = config;

  let started = false;
  // Set by stop() to cancel any in-flight start(). start() checks this after
  // each async boundary so a stopped handle can never re-animate.
  let closing = false;
  // In-flight startup promise — shared by concurrent start() calls so only
  // one initialization runs, and stop() can await it before tearing down.
  let startPromise: Promise<void> | null = null;
  let activeRenderer: CliRenderer | undefined;
  let cleanupResize: (() => void) | undefined;
  // Declared as `let` — reassigned in the debounce closure; justified by design
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handle: TuiAppHandle = {
    async start(): Promise<void> {
      if (started) return; // already running
      if (closing) return; // stop() was called — handle is permanently closed
      if (startPromise !== null) return startPromise; // concurrent call — share init

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
            localRenderer = await createCliRenderer({ exitOnCtrlC: false });
          } catch (e: unknown) {
            throw new Error("Failed to start TUI renderer", { cause: e });
          }
        }

        // Check cancellation after the async renderer creation — stop() may
        // have been called while we were waiting for FFI initialization.
        if (closing) {
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

        // Decision 15A: 50ms debounce — collapses 60+ resize events/sec to 1-2
        const onResize = (): void => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout((): void => {
            dispatchLayout();
            debounceTimer = null;
          }, 50);
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

        // Decision 4A: auto-mount the React tree.
        // If createRoot or the initial render throws, roll back all committed
        // state so the handle is left clean and retryable.
        try {
          const root = createRoot(activeRenderer);
          root.render(
            React.createElement(
              StoreContext.Provider,
              { value: store },
              React.createElement(TuiRoot, {
                onCommand,
                onSessionSelect,
                onSubmit,
                onInterrupt,
                onPermissionRespond: permissionBridge.respond,
              }),
            ),
          );
        } catch (e: unknown) {
          // Roll back everything committed above.
          started = false;
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
      closing = true;

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

      // Only destroy renderer we created; injected renderers are caller-owned
      if (activeRenderer !== undefined && injectedRenderer === undefined) {
        activeRenderer.destroy();
      }
      activeRenderer = undefined;
    },
  };

  return { ok: true, value: handle };
}
