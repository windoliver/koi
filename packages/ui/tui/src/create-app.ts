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
import type { ApprovalDecision } from "@koi/core/middleware";
// `createCliRenderer` uses a native Zig FFI library — lazy-import it inside
// start() so tests with an injected renderer never load the native binary.
import type { CliRenderer, SyntaxStyle, TreeSitterClient } from "@opentui/core";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import type { PermissionBridge } from "./bridge/permission-bridge.js";
import { initProfiling, shutdownProfiling } from "./profiling/integration.js";
import type { TuiStore } from "./state/store.js";
import type { FetchModelsResult, ModelEntry } from "./state/types.js";
import { wireStdinResurrection } from "./stdin-resurrection.js";
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
  /**
   * Called when the user selects a command from the palette or types a slash
   * command in the input. `args` is the trimmed text after the command name
   * (e.g., `/rewind 3` → `args = "3"`); empty string when no args were typed.
   */
  readonly onCommand: (commandId: string, args: string) => void;
  /** Called when the user selects a session to resume. */
  readonly onSessionSelect: (sessionId: string) => void;
  /** Called when the user submits a message. */
  readonly onSubmit: (text: string, mode?: "queue" | "interrupt") => void;
  /** Called when the user triggers Ctrl+C interrupt. */
  readonly onInterrupt: () => void;
  /**
   * Called when the user triggers session fork from the command palette (#13).
   * The host typically clones the current session and starts a fresh conversation
   * from the same context.
   */
  readonly onFork?: (() => void) | undefined;
  /**
   * Called when the user pastes an image from clipboard via Ctrl+V (#11).
   * The host collects these images and attaches them as image ContentBlocks
   * to the next add_user_message dispatched via onSubmit.
   */
  readonly onImageAttach?:
    | ((image: { readonly url: string; readonly mime: string }) => void)
    | undefined;
  /**
   * Called when a turn completes (agentStatus processing → idle) (#16).
   * Host can emit BEL or a desktop notification when the terminal is not focused.
   */
  readonly onTurnComplete?: (() => void) | undefined;
  /**
   * Optional renderer for testing (Decision 10A).
   * When provided, createTuiApp uses it directly instead of calling createCliRenderer().
   * The injected renderer is NOT destroyed on stop() — the caller owns its lifecycle.
   */
  readonly renderer?: CliRenderer | undefined;
  readonly screenMode?: "split-footer" | undefined;
  readonly footerHeight?: number | undefined;
  /**
   * Optional syntax style for JSON highlighting in tool call blocks and
   * (when paired with treeSitterClient) markdown rendering in TextBlock.
   * Created via SyntaxStyle.create() or SyntaxStyle.fromTheme() from @opentui/core.
   */
  readonly syntaxStyle?: SyntaxStyle | undefined;
  /**
   * Optional tree-sitter client for rich markdown rendering in assistant text.
   * When provided alongside syntaxStyle, TextBlock upgrades from <text> to
   * <markdown> with full prose/heading/code-fence support. See #1542.
   */
  readonly treeSitterClient?: TreeSitterClient | undefined;
  /**
   * Called when the @-mention query changes in the input area (#10).
   * The host uses this to run file completion (e.g., git ls-files + fuzzy filter)
   * and dispatch set_at_results back to the store. Null = overlay dismissed.
   */
  readonly onAtQuery?: ((query: string | null) => void) | undefined;
  /**
   * Called when the model picker opens. Host performs the provider /models
   * fetch and resolves the typed result; TuiRoot dispatches model_picker_fetched.
   */
  readonly onFetchModels?: (() => Promise<FetchModelsResult>) | undefined;
  /**
   * Called when the user selects a model in the picker. Host mutates the
   * current-model middleware box so subsequent turns use the new model.
   */
  readonly onModelSwitch?: ((model: ModelEntry) => boolean | undefined) | undefined;
}

// ---------------------------------------------------------------------------
// #1689 — stdin parser reset wrapper
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the objects the permission-respond wrapper
 * depends on — keeps the helper testable without pulling in
 * `@opentui/core` or `PermissionBridge` types.
 */
interface ParserResetDeps {
  readonly bridge: {
    readonly respond: (requestId: string, decision: ApprovalDecision) => void;
  };
  readonly renderer: {
    readonly stdinParser: { readonly reset: () => void } | null;
  };
}

/**
 * Read `stdinParser.reset` off a `CliRenderer` without touching the private
 * field directly. @opentui/core declares `stdinParser` private on the class,
 * but we need to reach the recovery hook without forking the dep. The field
 * is assigned once in the renderer's constructor and never reassigned, so
 * snapshotting a bound `reset` at mount time is safe.
 *
 * Returns `null` when the parser or its `reset` method is not present —
 * covers test renderers, unusual configs, and any future upstream rename.
 */
export function readStdinParserReset(renderer: CliRenderer): { readonly reset: () => void } | null {
  const parser: unknown = Reflect.get(renderer, "stdinParser");
  if (parser === null || parser === undefined || typeof parser !== "object") {
    return null;
  }
  const reset: unknown = Reflect.get(parser, "reset");
  if (typeof reset !== "function") {
    return null;
  }
  return {
    reset: (): void => {
      reset.call(parser);
    },
  };
}

/**
 * Build a `respond`-shaped callback that dispatches the permission response
 * through the bridge, then resets `renderer.stdinParser` to recover from
 * `@opentui/core@0.1.96`'s post-permission key-drop bug (#1689).
 *
 * `reset()` is the only parser operation that clears `paste`, `pending`,
 * `pendingSinceMs`, and the state machine in one step — the parser latch
 * that swallows Enter/Backspace/Esc/Tab cannot be unstuck any other way.
 *
 * Ordering matters: bridge.respond dispatches `permission_response` which
 * clears the modal synchronously; the reset runs after, so the parser is
 * unstuck exactly when focus returns to the input area.
 */
export function createPermissionRespondWithParserReset(
  deps: ParserResetDeps,
): (requestId: string, decision: ApprovalDecision) => void {
  return (requestId, decision): void => {
    deps.bridge.respond(requestId, decision);
    deps.renderer.stdinParser?.reset();
  };
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

  // Wave 5 measurement (#1586): wire profiler if KOI_TUI_PROFILE=1.
  // Must run AFTER the no-TTY guard — initProfiling() starts a repeating
  // interval that would otherwise keep a non-TTY process alive indefinitely.
  initProfiling();

  const {
    store,
    permissionBridge,
    onCommand,
    onSessionSelect,
    onSubmit,
    onInterrupt,
    onFork,
    onImageAttach,
    onTurnComplete,
    renderer: injectedRenderer,
    screenMode,
    footerHeight,
    syntaxStyle,
    treeSitterClient,
    onAtQuery,
    onFetchModels,
    onModelSwitch,
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
  // #1915 — handle for the stdin-resurrection helper. `disarm()` runs BEFORE
  // `renderer.destroy()` to prevent a stdin `'close'` event during teardown
  // from opening a fresh `/dev/tty`. `close()` runs AFTER so OpenTUI's own
  // cleanup can first execute on the live replacement stream.
  let stdinResurrectionHandle:
    | { readonly disarm: () => void; readonly close: () => void }
    | undefined;
  // Restores the store's previous fatal handler when stop() runs, so a
  // subsequent createTuiApp() invocation against the same store does not
  // see a stale closure pointing at this disposed handle (#1940).
  let restoreFatalHandler: (() => void) | undefined;
  // `let`: re-entrancy guard so a critical-subscriber failure during stop()
  // does not recursively trigger another stop().
  let fatalShutdownActive = false;
  // Captured reference to the renderer.once("destroy") handler so stop()
  // can unregister it before calling renderer.destroy(). Without this,
  // destroy's synchronous "destroy" event would fire the handler during
  // stop()'s own teardown and double-invoke the resurrection close at
  // exactly the wrong moment (mid-renderer-destroy).
  let externalDestroyHandler: (() => void) | undefined;

  const handle: TuiAppHandle = {
    done(): Promise<void> {
      return currentDone;
    },

    async start(): Promise<void> {
      if (started) return; // already running
      if (closing) return; // stop() was called — handle is permanently closed
      if (startPromise !== null) return startPromise; // concurrent call — share init

      // Wire fatal-listener teardown (#1940). Installed AFTER the concurrency
      // guard so concurrent start() calls do not stack multiple wrappers; the
      // unwind below restores the handler if start() fails so a failed start
      // does not leak a stale closure into the shared store.
      restoreFatalHandler = store.setFatalHandler((prev) => (err) => {
        if (fatalShutdownActive) return;
        fatalShutdownActive = true;
        // tui-single-writer-exception: renderer is about to be torn down.
        try {
          process.stderr.write(`[createTuiApp] critical subscriber failed: ${err.message}\n`);
        } catch {
          /* stderr unwritable — proceed to teardown anyway */
        }
        // Stop renderer first so subsequent caller teardown runs against a
        // dead UI. handle.stop() is idempotent — safe if `prev` also stops it.
        handle
          .stop()
          .catch(() => {})
          .finally(() => {
            try {
              prev(err);
            } catch {
              /* prev failures must not mask teardown */
            }
          });
      });

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

        // #1915 — rebind stdin if Bun's native reader destroys it mid-session.
        // Only wires for the real stdin; skip when the caller injected a
        // renderer (tests use a non-TTY stream, so resurrecting /dev/tty would
        // be both wrong and unavailable).
        if (injectedRenderer === undefined) {
          stdinResurrectionHandle = wireStdinResurrection(activeRenderer);
        }

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

        // #1689: wrap permissionBridge.respond so that every permission
        // decision (y/n/a or Esc-dismiss) triggers a stdin parser reset
        // immediately after the bridge dispatches `permission_response`.
        // See `createPermissionRespondWithParserReset` above for root-cause
        // and ordering notes. Wrapping `respond` is the single chokepoint
        // that covers both the keypress and Esc-dismiss paths in `TuiRoot`
        // without touching any of the view code.
        const wrappedPermissionRespond = createPermissionRespondWithParserReset({
          bridge: permissionBridge,
          renderer: { stdinParser: readStdinParserReset(activeRenderer) },
        });

        // If render throws, roll back all committed state so the handle is retryable.
        try {
          await render(
            () =>
              createComponent(StoreContext.Provider, {
                value: store,
                get children() {
                  // TuiRoot only needs StoreContext.Provider — the SolidJS
                  // store provides reactivity directly, no extra provider needed.
                  return createComponent(TuiRoot, {
                    onCommand,
                    onSessionSelect,
                    onSubmit,
                    onInterrupt,
                    onFork,
                    onImageAttach,
                    onTurnComplete,
                    onPermissionRespond: wrappedPermissionRespond,
                    syntaxStyle,
                    treeSitterClient,
                    onAtQuery,
                    onFetchModels,
                    onModelSwitch,
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
          // Disarm BEFORE destroy so a stdin close during localRenderer.destroy()
          // cannot open a fresh /dev/tty mid-teardown.
          stdinResurrectionHandle?.disarm();
          if (localRenderer !== injectedRenderer) {
            try {
              localRenderer.destroy();
            } catch {
              /* ignore secondary error */
            }
          }
          // Close AFTER renderer.destroy(): OpenTUI's cleanup calls
          // setRawMode(false) + removeListener on renderer.stdin. If we
          // closed the resurrected stream first, those calls would hit a
          // destroyed stream and OpenTUI could abort partway through its
          // own teardown.
          stdinResurrectionHandle?.close();
          stdinResurrectionHandle = undefined;
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
        // stop() being called, release all per-run resources so the handle
        // is cleanly restartable. Uses the restored `once` (not the capture
        // shim) — mount is complete.
        externalDestroyHandler = (): void => {
          if (keepAliveTimer !== null) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
          // Release the resize listener installed during start(). Without
          // this, a subsequent start() after external destroy adds a
          // second listener and the old one becomes unreachable, which
          // produces duplicate set_layout dispatches and an unbounded
          // listener leak across crash/restart cycles.
          cleanupResize?.();
          cleanupResize = undefined;
          // #1915 — external destruction must also tear down any resurrected
          // `/dev/tty` stream. `stop()` wouldn't run here (we didn't go
          // through it), so the helper's internal replacement would leak
          // without this call. stop() itself removes this handler before
          // calling renderer.destroy() so the two paths don't double-close.
          stdinResurrectionHandle?.close();
          stdinResurrectionHandle = undefined;
          // activeRenderer is dead — drop the reference so start() builds
          // a fresh one on the next invocation rather than reusing a
          // destroyed object.
          activeRenderer = undefined;
          currentDoneResolve?.();
          currentDoneResolve = null;
          currentDone = Promise.resolve();
          started = false;
          externalDestroyHandler = undefined;
        };
        activeRenderer.once("destroy", externalDestroyHandler);

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
        // The IIFE may have aborted (closing/stopGeneration changed) without
        // committing `started`. Treat that as a non-success and unwind the
        // fatal handler — stop() will not run for a never-mounted handle.
        if (!started) {
          restoreFatalHandler?.();
          restoreFatalHandler = undefined;
          fatalShutdownActive = false;
        }
      } catch (e) {
        // Renderer creation / render() failed. Unwind fatal handler so a
        // retry against the same store is not poisoned by a stale closure
        // bound to this disposed handle (#1940).
        restoreFatalHandler?.();
        restoreFatalHandler = undefined;
        fatalShutdownActive = false;
        throw e;
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

      // Restore the previous fatal handler so a later createTuiApp() against
      // the same store does not invoke this disposed instance's stop().
      restoreFatalHandler?.();
      restoreFatalHandler = undefined;
      fatalShutdownActive = false;

      // Dispose the Solid reactive root (releases store subscriptions, keyboard
      // hooks, etc.). We captured the dispose function during start() by
      // intercepting mountSolidRoot's renderer.once("destroy") registration.
      // Calling it directly avoids broadcasting the renderer's "destroy" event
      // to other listeners, which would incorrectly signal terminal destruction
      // to caller-owned renderers.
      solidRootDispose?.();
      solidRootDispose = undefined;

      // #1915 — disarm BEFORE renderer.destroy() so a stdin `'close'` event
      // during teardown cannot race in and open a fresh `/dev/tty`. The
      // replacement stream (if one is already open) stays alive so
      // OpenTUI's destroy can still call setRawMode(false) + removeListener
      // on it; we tear it down explicitly AFTER destroy returns.
      stdinResurrectionHandle?.disarm();

      // Only destroy the terminal renderer if we own it. renderer.destroy() also
      // fires "destroy" event, but solidRootDispose is already cleared above so
      // it won't be called twice (mountSolidRoot's once() listener is idempotent).
      //
      // stop() never rejects (matches the done()-contract comment at the top
      // of this file: "Never rejects — stop() catches all errors internally").
      // Unexpected destroy errors are logged via console.error but do NOT
      // propagate — the CLI's post-stop cleanup (resume hint, run report,
      // batcher dispose, filesystem backend close) must keep running even
      // when the renderer crashes on teardown; otherwise a shutdown-path
      // failure compounds into lost diagnostic output + leaked resources.
      if (activeRenderer !== undefined && injectedRenderer === undefined) {
        // #1915 — detach the external-destroy handler so renderer.destroy()'s
        // synchronous "destroy" emit doesn't invoke the resurrection close
        // mid-teardown. stop() explicitly runs the close AFTER destroy()
        // completes (see below). Without this `off()`, the handler would
        // close the replacement stream while OpenTUI is still calling
        // setRawMode(false) + stdin.removeListener on it.
        if (externalDestroyHandler !== undefined) {
          activeRenderer.off("destroy", externalDestroyHandler);
          externalDestroyHandler = undefined;
        }
        try {
          activeRenderer.destroy();
        } catch (e: unknown) {
          // Suppress only the known stdin-fd-invalid case (#1770):
          // renderer.destroy() calls setRawMode(false) which throws EBADF/ENOENT
          // when stdin fd is closed (stderr redirected, tmux detach).
          // The error may be a NodeJS.ErrnoException with .code, or a plain
          // Error with the errno in the message. Accept either shape, but
          // always require a setRawMode/errno:2 marker to avoid swallowing
          // unrelated errors.
          const errno = (e as NodeJS.ErrnoException).code;
          const hasErrnoCode = errno === "EBADF" || errno === "ENOENT";
          const hasRawModeMarker = e instanceof Error && /setRawMode|errno: 2/.test(e.message);
          const isStdinRawModeError = hasRawModeMarker && (hasErrnoCode || errno === undefined);
          if (!isStdinRawModeError) {
            // tui-single-writer-exception: renderer is being destroyed — no active
            // renderer owns the terminal at this point, so stderr write is safe
            // regardless of TTY state. Cannot dispatch to store (#1940).
            process.stderr.write(`[tui] stop: renderer.destroy() threw: ${String(e)}\n`);
          }
        }
      }
      activeRenderer = undefined;

      // #1915 — close the stdin-resurrection helper AFTER renderer.destroy()
      // so OpenTUI's cleanup (setRawMode(false), stdin.removeListener) runs
      // on a live replacement stream. `disarm()` above already prevented any
      // new resurrection during destroy; close() now tears the replacement
      // stream down explicitly so the /dev/tty fd doesn't leak past stop().
      stdinResurrectionHandle?.close();
      stdinResurrectionHandle = undefined;

      // Release the event-loop keepalive before resolving done() so the process
      // can exit normally once all other handles (stdin, timers) are drained.
      if (keepAliveTimer !== null) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      // Wave 5 measurement (#1586): stop the sampler and flush the report
      // bound to this run. Without this, the sampler would keep ticking
      // through idle time after stop() and contaminate any subsequent
      // createTuiApp() in the same process. No-op when profiling is off.
      shutdownProfiling();

      // Resolve the per-run deferred — unblocks callers awaiting handle.done().
      currentDoneResolve?.();
      currentDoneResolve = null;
      currentDone = Promise.resolve();
    },
  };

  return { ok: true, value: handle };
}
