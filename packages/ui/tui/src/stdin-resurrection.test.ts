/**
 * Tests for #1915 stdin-resurrection workaround.
 *
 * Uses `Readable.from([])` as a stand-in watch stream so we can emit 'close'
 * deterministically without touching real `process.stdin`. The replacement
 * stream is also a plain `Readable` — the production path plugs a real
 * `tty.ReadStream` in, but the contract the renderer relies on (on("data"),
 * resume(), setRawMode()) is polyfilled here.
 */

import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { CliRenderer } from "@opentui/core";
import { wireStdinResurrection } from "./stdin-resurrection.js";

interface FakeRenderer {
  stdin?: unknown;
  stdinListener?: (chunk: unknown) => void;
  _isDestroyed?: boolean;
  _destroyPending?: boolean;
}

interface FakeReplacement {
  readonly emitter: EventEmitter;
  readonly resume: ReturnType<typeof mock>;
  readonly setRawMode: ReturnType<typeof mock>;
  readonly onData: ReturnType<typeof mock>;
  readonly pause: ReturnType<typeof mock>;
  readonly destroy: ReturnType<typeof mock>;
}

function makeReplacement(options: { setRawModeThrows?: boolean } = {}): FakeReplacement {
  const emitter = new EventEmitter();
  const onData = mock((_chunk: unknown) => {});
  const instance: FakeReplacement = {
    emitter,
    resume: mock(() => {}),
    setRawMode: mock((_raw: boolean) => {
      if (options.setRawModeThrows) throw new Error("setRawMode failed");
    }),
    onData,
    pause: mock(() => {}),
    destroy: mock((_err?: Error) => {}),
  };
  // Proxy on() so the production code's `replacement.on("data", listener)`
  // lands on the emitter, and we can assert via emitter.listenerCount.
  (instance as unknown as Record<string, unknown>).on = (
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): FakeReplacement => {
    emitter.on(event, listener);
    return instance;
  };
  return instance;
}

function makeWatchStream(): EventEmitter & Pick<Readable, "once" | "removeListener"> {
  return new EventEmitter() as EventEmitter & Pick<Readable, "once" | "removeListener">;
}

describe("wireStdinResurrection", () => {
  test("opens a fresh stream and rebinds listener when watched stdin closes", () => {
    const watchStream = makeWatchStream();
    const replacement = makeReplacement();
    const stdinListener = mock((_chunk: unknown) => {});
    const renderer: FakeRenderer = { stdinListener };
    const onResurrect = mock(() => {});
    const openDevTty = mock(() => replacement as unknown as Readable);

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
      onResurrect,
    });

    watchStream.emit("close");

    expect(openDevTty).toHaveBeenCalledTimes(1);
    expect(replacement.setRawMode).toHaveBeenCalledWith(true);
    expect(replacement.resume).toHaveBeenCalledTimes(1);
    expect(replacement.emitter.listenerCount("data")).toBe(1);

    // Deliver a chunk via the new stream and prove it reaches the renderer's listener.
    replacement.emitter.emit("data", Buffer.from("x"));
    expect(stdinListener).toHaveBeenCalledWith(Buffer.from("x"));

    // renderer.stdin is pointed at the live replacement so subsequent pause/resume
    // touches the new stream, not the destroyed one.
    expect(renderer.stdin).toBe(replacement);
    expect(onResurrect).toHaveBeenCalledTimes(1);
  });

  test("skips resurrection when renderer is already destroyed", () => {
    const watchStream = makeWatchStream();
    const openDevTty = mock(() => ({}) as Readable);
    const renderer: FakeRenderer = {
      stdinListener: mock((_c: unknown) => {}),
      _isDestroyed: true,
    };

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    watchStream.emit("close");
    expect(openDevTty).not.toHaveBeenCalled();
  });

  test("skips resurrection when renderer has destroy pending", () => {
    const watchStream = makeWatchStream();
    const openDevTty = mock(() => ({}) as Readable);
    const renderer: FakeRenderer = {
      stdinListener: mock((_c: unknown) => {}),
      _destroyPending: true,
    };

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    watchStream.emit("close");
    expect(openDevTty).not.toHaveBeenCalled();
  });

  test("close() removes the watcher so later closes are ignored", () => {
    const watchStream = makeWatchStream();
    const openDevTty = mock(() => makeReplacement() as unknown as Readable);
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    handle.close();
    watchStream.emit("close");
    expect(openDevTty).not.toHaveBeenCalled();
  });

  test("skips gracefully when openDevTty throws", () => {
    const watchStream = makeWatchStream();
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };
    const openDevTty = mock(() => {
      throw new Error("ENXIO /dev/tty");
    });

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    expect(() => watchStream.emit("close")).not.toThrow();
    // renderer.stdin unchanged because resurrection aborted before the rebind.
    expect(renderer.stdin).toBeUndefined();
  });

  test("skips resurrection when renderer exposes no stdinListener", () => {
    const watchStream = makeWatchStream();
    const openDevTty = mock(() => makeReplacement() as unknown as Readable);
    const renderer: FakeRenderer = {}; // no stdinListener

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    watchStream.emit("close");
    expect(openDevTty).not.toHaveBeenCalled();
  });

  test("swallows setRawMode failure on the replacement and still rebinds", () => {
    const watchStream = makeWatchStream();
    const replacement = makeReplacement({ setRawModeThrows: true });
    const stdinListener = mock((_c: unknown) => {});
    const renderer: FakeRenderer = { stdinListener };
    const openDevTty = mock(() => replacement as unknown as Readable);

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    expect(() => watchStream.emit("close")).not.toThrow();
    expect(replacement.resume).toHaveBeenCalledTimes(1);
    expect(replacement.emitter.listenerCount("data")).toBe(1);
  });

  test("close() tears down the replacement stream after a resurrection fired", () => {
    const watchStream = makeWatchStream();
    const replacement = makeReplacement();
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };
    const openDevTty = mock(() => replacement as unknown as Readable);

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    watchStream.emit("close");
    expect(replacement.destroy).not.toHaveBeenCalled();

    handle.close();
    expect(replacement.setRawMode).toHaveBeenCalledWith(false);
    expect(replacement.pause).toHaveBeenCalledTimes(1);
    expect(replacement.destroy).toHaveBeenCalledTimes(1);
  });

  test("disarm() stops future resurrection without touching an open replacement", () => {
    // After a resurrection has fired, disarm() should remove the watcher
    // but leave the replacement stream alive so the renderer's own
    // teardown can still read from it. The replacement is only destroyed
    // on close().
    const watchStream = makeWatchStream();
    const replacement = makeReplacement();
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };
    const openDevTty = mock(() => replacement as unknown as Readable);

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    watchStream.emit("close");
    expect(openDevTty).toHaveBeenCalledTimes(1);

    handle.disarm();
    // Replacement is still alive after disarm.
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(replacement.pause).not.toHaveBeenCalled();

    // And a late 'close' event must NOT open another /dev/tty.
    const second = makeWatchStream();
    // (use the original watchStream — it still has no armed listener after disarm)
    watchStream.emit("close");
    expect(openDevTty).toHaveBeenCalledTimes(1);

    // close() now tears down the replacement.
    handle.close();
    expect(replacement.destroy).toHaveBeenCalledTimes(1);
    // void secondary watchStream to keep lint happy in a readonly-style test
    void second;
  });

  test("disarm() before a mid-teardown 'close' event prevents opening a new /dev/tty", () => {
    // Regression for the round-8 finding: `stop()` must disarm BEFORE
    // `renderer.destroy()` so a stdin close during teardown cannot race
    // into a fresh resurrection.
    const watchStream = makeWatchStream();
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };
    const openDevTty = mock(() => makeReplacement() as unknown as Readable);

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    // Teardown order: disarm, then the underlying stream closes mid-destroy.
    handle.disarm();
    watchStream.emit("close");

    expect(openDevTty).not.toHaveBeenCalled();
  });

  test("close() is a no-op when no resurrection happened", () => {
    const watchStream = makeWatchStream();
    const replacement = makeReplacement();
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };
    const openDevTty = mock(() => replacement as unknown as Readable);

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    expect(() => handle.close()).not.toThrow();
    // Nothing ever opened, nothing should tear down.
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(replacement.pause).not.toHaveBeenCalled();
  });

  test("proactively resurrects on Bun's post-EOF _readableState.destroyed shape", () => {
    // Live instrumentation during #1915 observed the post-wedge state on
    // `_readableState.destroyed`, not the top-level `.destroyed` getter.
    // Guard against the possibility that Bun's custom stdin only flips the
    // internal field.
    const watchStream = makeWatchStream() as EventEmitter &
      Pick<Readable, "once" | "removeListener"> & { _readableState?: { destroyed: boolean } };
    watchStream._readableState = { destroyed: true };
    const replacement = makeReplacement();
    const stdinListener = mock((_c: unknown) => {});
    const renderer: FakeRenderer = { stdinListener };
    const openDevTty = mock(() => replacement as unknown as Readable);

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    expect(openDevTty).toHaveBeenCalledTimes(1);
    expect(renderer.stdin).toBe(replacement);
  });

  test("idempotent: proactive + close-event sequence still opens only one replacement", () => {
    // destroyed:true at wire time AND a pending 'close' — the guard must
    // prevent doResurrect from opening a second /dev/tty and leaking the first.
    const watchStream = makeWatchStream() as EventEmitter &
      Pick<Readable, "once" | "removeListener"> & { destroyed?: boolean };
    watchStream.destroyed = true;
    const replacement = makeReplacement();
    const stdinListener = mock((_c: unknown) => {});
    const renderer: FakeRenderer = { stdinListener };
    const openDevTty = mock(() => replacement as unknown as Readable);

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });
    watchStream.emit("close"); // second trigger

    expect(openDevTty).toHaveBeenCalledTimes(1);
    expect(replacement.setRawMode).toHaveBeenCalledTimes(1);
  });

  test("proactively resurrects when the watched stream is already destroyed at wire time", () => {
    // Simulate restart-after-wedge: process.stdin was destroyed in a prior
    // TUI instance and `'close'` already fired. A naive `once("close")` would
    // never trigger; we must detect the destroyed state up front and open a
    // replacement immediately.
    const watchStream = makeWatchStream() as EventEmitter &
      Pick<Readable, "once" | "removeListener"> & { destroyed?: boolean };
    watchStream.destroyed = true;
    const replacement = makeReplacement();
    const stdinListener = mock((_c: unknown) => {});
    const renderer: FakeRenderer = { stdinListener };
    const openDevTty = mock(() => replacement as unknown as Readable);

    wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    expect(openDevTty).toHaveBeenCalledTimes(1);
    expect(replacement.setRawMode).toHaveBeenCalledWith(true);
    expect(replacement.resume).toHaveBeenCalledTimes(1);
    expect(renderer.stdin).toBe(replacement);
  });

  test("close() swallows setRawMode/pause/destroy errors during teardown", () => {
    const watchStream = makeWatchStream();
    const replacement = makeReplacement();
    replacement.setRawMode.mockImplementation((_raw: boolean) => {
      throw new Error("setRawMode EBADF");
    });
    replacement.pause.mockImplementation(() => {
      throw new Error("pause failed");
    });
    replacement.destroy.mockImplementation((_err?: Error) => {
      throw new Error("destroy failed");
    });
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };
    const openDevTty = mock(() => replacement as unknown as Readable);

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    watchStream.emit("close");
    expect(() => handle.close()).not.toThrow();
    // All three were attempted despite each throwing.
    expect(replacement.pause).toHaveBeenCalledTimes(1);
    expect(replacement.destroy).toHaveBeenCalledTimes(1);
  });
});
