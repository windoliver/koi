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
  /** Detach the close-watcher. Idempotent; safe to call after a resurrection. */
  readonly dispose: () => void;
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

  const onClose = (): void => {
    if (disposed) return;
    if (rendererIsShuttingDown(renderer)) return;

    const listener = readStdinListener(renderer);
    if (listener === null) return;

    // let: assigned inside try/catch, read after. Declared outside so the
    // listener-rebind path can see the value set by the successful branch.
    let replacement: Readable & { readonly setRawMode?: (raw: boolean) => void };
    try {
      replacement = openDevTty();
    } catch {
      // Can't open /dev/tty (not a controlling terminal, or ENXIO).
      // Give up quietly — the TUI will stay wedged, but that was the
      // baseline before this workaround existed, so we haven't regressed.
      return;
    }

    try {
      replacement.setRawMode?.(true);
    } catch {
      // setRawMode can fail on a fd that isn't actually a TTY in tests.
      // Keep going — the listener will still receive data even without
      // raw mode, which is strictly better than no input at all.
    }

    Reflect.set(renderer, "stdin", replacement);
    replacement.on("data", listener);
    replacement.resume();
    options.onResurrect?.();
  };

  watchStream.once("close", onClose);

  return {
    dispose: (): void => {
      disposed = true;
      watchStream.removeListener("close", onClose);
    },
  };
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
