/**
 * TuiStore — SolidJS store with reconcile()-based updates.
 *
 * Uses the pure reducer to compute new state, then `reconcile()` to
 * deep-diff old vs new and fire fine-grained SolidJS signals for every
 * property that changed. This gives us:
 * - Correct fine-grained reactivity (nested text changes fire signals)
 * - Pure reducer logic (116 existing tests, predictable, testable)
 * - SolidJS-native signal integration (no intermediate signal bridge)
 *
 * Trade-off: reconcile() is O(state-tree-size) per dispatch. For typical
 * conversation sizes this is fast (~1ms). If profiling shows issues at
 * 500+ messages, switch the text_delta hot path to path-based setters.
 */

import type { EngineEvent } from "@koi/core/engine";
import { createStore as createSolidStore, produce, reconcile } from "solid-js/store";
import { reduce } from "./reduce.js";
import type { TuiAction, TuiState } from "./types.js";

/** Listener callback — notified when state changes. */
export type StateListener = () => void;

/** Minimal store API — same interface as the previous reducer-based store. */
export interface TuiStore {
  /** Returns the reactive proxy. Reads inside Solid scopes are tracked. */
  readonly getState: () => TuiState;
  readonly dispatch: (action: TuiAction) => void;
  /**
   * Apply an array of actions in one pass and notify listeners once.
   * Used by EventBatcher to coalesce batched events.
   */
  readonly dispatchBatch: (actions: readonly TuiAction[]) => void;
  /**
   * Fast-path for text_delta / thinking_delta during streaming.
   *
   * Bypasses reconcile() — uses produce() for an O(1) path mutation that
   * fires only the leaf `text` signal, not a full state-tree diff.
   * Falls back to reconcile() when structural changes are needed (first
   * delta of a new block kind, no streaming assistant message).
   *
   * Called directly from drainEngineStream instead of going through the
   * batcher, so each delta can render immediately.
   */
  readonly streamDelta: (delta: string, blockKind: "text" | "thinking") => void;
  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   *
   * Pass `{ critical: true }` for the renderer-health subscriber whose
   * failure must trigger fatal teardown (#1940). Non-critical subscribers
   * are quarantined on throw without escalating; their failure is surfaced
   * as an in-band error block.
   */
  readonly subscribe: (
    listener: StateListener,
    options?: { readonly critical?: boolean },
  ) => () => void;
  /**
   * Install a fatal handler invoked when a critical subscriber throws. The
   * factory receives the currently-installed handler so the new handler can
   * chain (e.g. perform local teardown then delegate to caller-supplied
   * shutdown). Returns a cleanup that restores the previous handler.
   * Used by createTuiApp to wire fatal → handle.stop() while still respecting
   * a CLI-supplied broader shutdown.
   */
  readonly setFatalHandler: (
    factory: (prev: (e: Error) => void) => (e: Error) => void,
  ) => () => void;
}

/** Options for createStore. */
export interface CreateStoreOptions {
  /**
   * Invoked when a subscriber registered with `{ critical: true }` throws.
   * The app owns orderly shutdown (renderer.destroy, stdin restore) and
   * should call its TuiAppHandle.stop() here. Default behavior: log to
   * stderr and return — does not crash the host process. Active-TUI
   * consumers (e.g. the CLI) MUST supply their own handler to avoid a
   * silent dead UI; embedded/library consumers may rely on the default.
   */
  readonly onFatal?: (e: Error) => void;
}

/** Create a TuiStore backed by SolidJS fine-grained reactive store. */
export function createStore(initialState: TuiState, options: CreateStoreOptions = {}): TuiStore {
  const [state, setState] = createSolidStore(initialState);
  const listeners = new Set<StateListener>();
  // Subset of `listeners` flagged critical: their failure escalates to the
  // fatal teardown path. Renderer-health subscribers should opt in via
  // subscribe(fn, { critical: true }).
  const criticalListeners = new Set<StateListener>();
  const defaultFatal = (err: Error): void => {
    // Default: log loudly but DO NOT crash the host process. Consumers that
    // own an active TUI (createTuiApp) install their own handler via
    // setFatalHandler() so renderer.destroy + stdin restore can run.
    // Crashing here would terminate any embedded host whose critical
    // subscriber happened to throw.
    // tui-single-writer-exception: renderer presumed dead; raw stderr ok.
    try {
      process.stderr.write(
        `[TuiStore] critical subscriber failed without fatal handler: ${err.message}\n`,
      );
    } catch {
      /* stderr unwritable — best effort */
    }
  };
  // `let`: replaced via setFatalHandler() so app-lifecycle owners can install
  // teardown without coordinating at createStore() time.
  let onFatal: (e: Error) => void = options.onFatal ?? defaultFatal;

  // `let` justified: snapshot for reducer input (reconcile needs the raw state)
  let snapshot: TuiState = initialState;
  // `let` justified: mutable flag for microtask-batched notification coalescing
  let pendingNotify = false;

  function notifySubscribers(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (e: unknown) {
        // Quarantine the offending listener immediately so re-dispatch below does
        // not re-enter it (no infinite loop, no duplicate error blocks).
        const wasCritical = criticalListeners.delete(listener);
        listeners.delete(listener);
        const msg = `[TuiStore] listener threw: ${String(e)}\n`;
        if (wasCritical) {
          // Renderer-health subscriber died — escalate to fatal teardown.
          // tui-single-writer-exception: renderer is presumed dead; safe to
          // write raw stderr (no competing single writer remains). Wrapped in
          // try/catch because stderr can already be closed during embedded
          // teardown — fatal handoff must run regardless of logging success.
          try {
            process.stderr.write(`${msg}[TuiStore] critical subscriber lost.\n`);
          } catch {
            /* stderr unwritable — fall through to onFatal */
          }
          const err = e instanceof Error ? e : new Error(String(e));
          onFatal(err);
          return;
        }
        // tui-single-writer-exception: stderr only when not a TTY — in interactive
        // sessions the remaining renderer controls stdout+stderr; write there
        // would interleave with rendered frames. CI / piped contexts always log.
        if (!process.stderr.isTTY) {
          process.stderr.write(msg);
        }
        // Surface in TUI via normal dispatch — notifies remaining subscribers so
        // the error block is rendered. Safe from re-entry: bad listener is gone.
        queueMicrotask(() => {
          dispatch({
            kind: "add_error",
            code: "STORE_LISTENER_ERROR",
            message: `Store listener threw: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
      }
    }
  }

  function scheduleNotify(): void {
    if (listeners.size === 0) return;
    if (!pendingNotify) {
      pendingNotify = true;
      queueMicrotask(() => {
        pendingNotify = false;
        notifySubscribers();
      });
    }
  }

  function applyState(next: TuiState): void {
    if (next === snapshot) return; // no-op guard
    snapshot = next;
    // reconcile() deep-diffs old vs new and fires signals for every change
    setState(reconcile(next));
  }

  function dispatch(action: TuiAction): void {
    applyState(reduce(snapshot, action));
    scheduleNotify();
  }

  function dispatchBatch(actions: readonly TuiAction[]): void {
    if (actions.length === 0) return;
    let current = snapshot;
    for (const action of actions) {
      current = reduce(current, action);
    }
    applyState(current);
    // Notify synchronously — caller (EventBatcher flush) already rate-limits
    notifySubscribers();
  }

  function getState(): TuiState {
    return state;
  }

  function subscribe(
    listener: StateListener,
    subOptions?: { readonly critical?: boolean },
  ): () => void {
    listeners.add(listener);
    if (subOptions?.critical === true) {
      criticalListeners.add(listener);
    }
    return () => {
      listeners.delete(listener);
      criticalListeners.delete(listener);
    };
  }

  function streamDelta(delta: string, blockKind: "text" | "thinking"): void {
    if (delta === "") return;

    // 1. Update snapshot via pure reducer — keeps it consistent with the store.
    const eventKind: EngineEvent["kind"] = blockKind === "text" ? "text_delta" : "thinking_delta";
    const action: TuiAction = {
      kind: "engine_event",
      event: { kind: eventKind, delta } as EngineEvent,
    };
    const next = reduce(snapshot, action);
    if (next === snapshot) return;
    snapshot = next;

    // 2. Fast path: surgical text update via produce() — O(1), fires only the
    //    leaf `text` signal. Avoids reconcile's O(state-tree) diff on every delta.
    const messages = state.messages;
    // Scan from the end for the last assistant message
    let msgIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.kind === "assistant") {
        msgIdx = i;
        break;
      }
    }

    if (msgIdx < 0) {
      // No assistant message — structural change, fall back to reconcile
      setState(reconcile(next));
      scheduleNotify();
      return;
    }

    const msg = messages[msgIdx];
    if (msg?.kind !== "assistant" || !msg.streaming) {
      setState(reconcile(next));
      scheduleNotify();
      return;
    }

    const blockIdx = msg.blocks.length - 1;
    const block = msg.blocks[blockIdx];

    if (block !== undefined && block.kind === blockKind) {
      // Fast path: append to existing block's text
      setState(
        produce((draft) => {
          const draftMsg = draft.messages[msgIdx];
          if (draftMsg?.kind === "assistant") {
            const draftBlock = draftMsg.blocks[blockIdx];
            if (draftBlock !== undefined && draftBlock.kind === blockKind) {
              (draftBlock as { text: string }).text = draftBlock.text + delta;
            }
          }
        }),
      );
    } else {
      // Block kind mismatch or empty blocks — structural change, fall back
      setState(reconcile(next));
    }
    scheduleNotify();
  }

  function setFatalHandler(fn: (prev: (e: Error) => void) => (e: Error) => void): () => void {
    const previous = onFatal;
    const installed = fn(previous);
    onFatal = installed;
    return () => {
      // Only restore if no other override has stacked on top.
      if (onFatal === installed) onFatal = previous;
    };
  }

  return { getState, dispatch, dispatchBatch, streamDelta, subscribe, setFatalHandler };
}
