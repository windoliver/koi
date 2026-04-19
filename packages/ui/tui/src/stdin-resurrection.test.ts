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

  test("dispose() removes the close listener so later closes are ignored", () => {
    const watchStream = makeWatchStream();
    const openDevTty = mock(() => makeReplacement() as unknown as Readable);
    const renderer: FakeRenderer = { stdinListener: mock((_c: unknown) => {}) };

    const handle = wireStdinResurrection(renderer as unknown as CliRenderer, {
      watchStream: watchStream as unknown as Readable,
      openDevTty,
    });

    handle.dispose();
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
});
