/**
 * #1915 — Stdin resurrection workaround for Bun `internalRead` EOF.
 *
 * Bun 1.3.10's native stdin reader (`internalRead`) destroys
 * `process.stdin` when its underlying ReadableStream reader returns
 * `done:true`. Koi's two-write-to-same-file turn flow deterministically
 * triggers this; after the second turn the stream is dead and the TUI
 * looks wedged (keys silently drop). When that happens, open a fresh TTY
 * file descriptor on `/dev/tty`, rebind OpenTUI's private `stdinListener`
 * to the new stream, and re-point `renderer.stdin` so subsequent
 * suspend / resume paths touch the live stream, not the corpse.
 *
 * When Bun's `internalRead` is fixed upstream, the `'close'` event never
 * fires on a live TUI and this code path stays dormant.
 *
 * @see docs/L2/tui.md — "#1915 — Stdin resurrection after Bun
 *   `internalRead` EOF" for the incident writeup.
 */

import { constants as fsConstants, openSync } from "node:fs";
import type { Readable } from "node:stream";
import { ReadStream } from "node:tty";
import type { CliRenderer } from "@opentui/core";

/**
 * Factory that returns a fresh read-only stream bound to the controlling
 * terminal. Production opens `/dev/tty` via `node:fs` + `node:tty`. Tests
 * inject a fake.
 */
export type OpenDevTtyFn = () => Readable & {
  readonly setRawMode?: (raw: boolean) => void;
};

export interface WireStdinResurrectionOptions {
  /** Stream to watch for close. Defaults to `process.stdin`. */
  readonly watchStream?: Readable;
  /** Replacement-stream factory. Defaults to opening `/dev/tty`. */
  readonly openDevTty?: OpenDevTtyFn;
  /** Observability hook invoked after a successful rebind. */
  readonly onResurrect?: () => void;
}

export interface WireStdinResurrectionResult {
  /**
   * Disable future resurrection without touching any replacement stream
   * that is already open. Idempotent.
   *
   * Call this BEFORE `renderer.destroy()` during shutdown so a `'close'`
   * event racing in between "shutdown started" and "renderer flagged
   * destroyed" can't open a fresh `/dev/tty` mid-teardown. The replacement
   * stream is left alive so OpenTUI's destroy — which calls
   * `setRawMode(false)` + `removeListener` on `renderer.stdin` — can run
   * against a live source.
   */
  readonly disarm: () => void;
  /**
   * Full teardown: `disarm()` + tear down any replacement stream (pause,
   * destroy, clear raw mode). Idempotent.
   *
   * Call this AFTER `renderer.destroy()` during shutdown. Safe to call
   * even if `disarm()` already ran — it's a no-op for the watcher side.
   */
  readonly close: () => void;
}

type StdinListener = (chunk: unknown) => void;

/**
 * Attach a one-shot close watcher to `watchStream` (default: `process.stdin`).
 * On close — while the renderer is still live — open a fresh `/dev/tty`
 * stream, set raw mode on it, and rebind OpenTUI's stdinListener.
 */
export function wireStdinResurrection(
  renderer: CliRenderer,
  options: WireStdinResurrectionOptions = {},
): WireStdinResurrectionResult {
  const watchStream = options.watchStream ?? process.stdin;
  const openDevTty = options.openDevTty ?? defaultOpenDevTty;
  // let: flipped by dispose() to short-circuit a close that races teardown.
  let disposed = false;
  // let: tracks the replacement stream so dispose() can tear it down. Without
  // this, the fresh /dev/tty fd would outlive stop() — OpenTUI's destroy path
  // only removes the data listener, it doesn't close/pause the underlying
  // stream, so we'd leak a TTY handle per resurrection.
  let replacement: ReplacementStream | undefined;

  const doResurrect = (): void => {
    if (disposed) return;
    // Idempotent: if a prior call already opened a replacement, do NOT open
    // a second `/dev/tty` fd. Can happen when `destroyed === true` at wire
    // time AND a `'close'` event is still pending — we'd otherwise leak the
    // first fd and silently attach a second live stream.
    if (replacement !== undefined) return;
    if (rendererIsShuttingDown(renderer)) return;

    const listener = readStdinListener(renderer);
    if (listener === null) return;

    // let: assigned inside try/catch, read after. Declared outside so the
    // listener-rebind path can see the value set by the successful branch.
    let fresh: ReplacementStream;
    try {
      fresh = openDevTty();
    } catch {
      // Can't open /dev/tty (not a controlling terminal, or ENXIO).
      // Give up quietly — the TUI will stay wedged, but that was the
      // baseline before this workaround existed, so we haven't regressed.
      return;
    }

    try {
      fresh.setRawMode?.(true);
    } catch {
      // setRawMode can fail on a fd that isn't actually a TTY in tests.
      // Keep going — the listener will still receive data even without
      // raw mode, which is strictly better than no input at all.
    }

    Reflect.set(renderer, "stdin", fresh);
    fresh.on("data", listener);
    fresh.resume();
    replacement = fresh;
    options.onResurrect?.();
  };

  // If the watched stream is already destroyed at wire time, its 'close'
  // has already fired and the one-shot listener below will never run.
  // This path matters for restart-after-wedge: `createTuiApp` is
  // restartable (`stop()` → `start()` again), and a prior Bun
  // `internalRead` EOF leaves `process.stdin` destroyed for the next
  // instance. Resurrect up front so the new TUI has a live stream from
  // its first keystroke.
  if (isStreamDestroyed(watchStream)) {
    doResurrect();
  }

  watchStream.once("close", doResurrect);

  const disarm = (): void => {
    disposed = true;
    watchStream.removeListener("close", doResurrect);
  };

  return {
    disarm,
    close: (): void => {
      disarm();
      if (replacement !== undefined) {
        tearDownReplacement(replacement);
        replacement = undefined;
      }
    },
  };
}

/**
 * True if the Readable is destroyed. Checks both the public `.destroyed`
 * getter AND the internal `_readableState.destroyed` — issue #1915's live
 * instrumentation actually observed the state transition on
 * `_readableState.destroyed` first, and the public getter's equivalence in
 * Bun's custom stdin is not a contract we can rely on blind. Belt +
 * suspenders. Either field being `true` means the stream is dead.
 */
function isStreamDestroyed(stream: Readable): boolean {
  if (Reflect.get(stream, "destroyed") === true) return true;
  const rs: unknown = Reflect.get(stream, "_readableState");
  if (rs !== null && typeof rs === "object" && Reflect.get(rs, "destroyed") === true) {
    return true;
  }
  return false;
}

type ReplacementStream = Readable & {
  readonly setRawMode?: (raw: boolean) => void;
};

/**
 * Pause and destroy the resurrected stream. Best-effort: each step swallows
 * errors so partial failure (e.g. setRawMode throws on a non-TTY in tests)
 * can't block the rest of dispose().
 */
function tearDownReplacement(stream: ReplacementStream): void {
  try {
    stream.setRawMode?.(false);
  } catch {
    /* ignore — setRawMode on a closed or non-TTY fd is expected to fail */
  }
  try {
    stream.pause();
  } catch {
    /* ignore */
  }
  try {
    stream.destroy();
  } catch {
    /* ignore */
  }
}

/** Read OpenTUI's private `stdinListener` without forking the dep. */
function readStdinListener(renderer: CliRenderer): StdinListener | null {
  const candidate: unknown = Reflect.get(renderer, "stdinListener");
  if (typeof candidate !== "function") return null;
  const fn = candidate;
  return (chunk: unknown): void => {
    fn(chunk);
  };
}

/**
 * Detect whether the renderer is already tearing down. Close during
 * legitimate shutdown is expected and should NOT trigger resurrection —
 * that would re-open a TTY fd on an exiting process and leak the handle.
 */
function rendererIsShuttingDown(renderer: CliRenderer): boolean {
  if (Reflect.get(renderer, "_isDestroyed") === true) return true;
  if (Reflect.get(renderer, "_destroyPending") === true) return true;
  return false;
}

function defaultOpenDevTty(): Readable & { readonly setRawMode?: (raw: boolean) => void } {
  const fd = openSync("/dev/tty", fsConstants.O_RDONLY);
  return new ReadStream(fd);
}
