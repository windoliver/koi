/**
 * Regression test for #1770 — renderer.destroy() must not crash when
 * stdin fd is invalid (EBADF/ENOENT from setRawMode).
 *
 * The guard accepts two error shapes:
 *   1. NodeJS.ErrnoException with .code = "EBADF"/"ENOENT" + setRawMode/errno:2 message
 *   2. Plain Error with setRawMode/errno:2 message and no .code (renderer may not set it)
 *
 * Unrelated ENOENT/EBADF errors (without setRawMode marker) propagate normally.
 */

import { describe, expect, test } from "bun:test";

/**
 * Replicates the guard logic from create-app.ts stop() so we can test
 * the pattern in isolation without instantiating a real renderer.
 */
function destroyWithGuard(renderer: { destroy(): void }): void {
  try {
    renderer.destroy();
  } catch (e: unknown) {
    const errno = (e as NodeJS.ErrnoException).code;
    const hasErrnoCode = errno === "EBADF" || errno === "ENOENT";
    const hasRawModeMarker = e instanceof Error && /setRawMode|errno: 2/.test(e.message);
    const isStdinRawModeError = hasRawModeMarker && (hasErrnoCode || errno === undefined);
    if (!isStdinRawModeError) throw e;
  }
}

/**
 * Replicates the #1915 deferred-rethrow pattern: if `destroy()` throws an
 * unexpected error, `actions` must still run (keepalive clear, done
 * resolve, replacement-stream close, etc.) before the error propagates.
 */
function destroyThenCleanupThenRethrow(renderer: { destroy(): void }, actions: () => void): void {
  // let: captured in catch, rethrown after cleanup
  let deferredError: unknown;
  try {
    renderer.destroy();
  } catch (e: unknown) {
    const errno = (e as NodeJS.ErrnoException).code;
    const hasErrnoCode = errno === "EBADF" || errno === "ENOENT";
    const hasRawModeMarker = e instanceof Error && /setRawMode|errno: 2/.test(e.message);
    const isStdinRawModeError = hasRawModeMarker && (hasErrnoCode || errno === undefined);
    if (!isStdinRawModeError) deferredError = e;
  }
  actions();
  if (deferredError !== undefined) throw deferredError;
}

describe("renderer.destroy() error handling", () => {
  test("EBADF with .code from setRawMode is suppressed", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("setRawMode failed with errno: 2");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).not.toThrow();
  });

  test("plain Error (no .code) with setRawMode message is suppressed", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("setRawMode failed with errno: 2");
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).not.toThrow();
  });

  test("ENOENT with .code and setRawMode marker is suppressed", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("ENOENT: no such file or directory, setRawMode");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).not.toThrow();
  });

  test("non-EBADF errors from destroy propagate", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("renderer native crash: segfault in wgpu");
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).toThrow("renderer native crash");
  });

  test("ENOENT without setRawMode marker propagates (unrelated file error)", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("ENOENT: no such file or directory, /tmp/renderer.sock");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).toThrow("ENOENT");
  });

  test("EBADF without setRawMode marker propagates (unrelated fd error)", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("EBADF: bad file descriptor, close");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).toThrow("EBADF");
  });

  test("error with unrelated .code but setRawMode message propagates", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("setRawMode failed with errno: 2");
        (err as NodeJS.ErrnoException).code = "EPERM";
        throw err;
      },
    };
    expect(() => destroyWithGuard(fakeRenderer)).toThrow("setRawMode");
  });
});

// ---------------------------------------------------------------------------
// #1915 — deferred-rethrow pattern ensures teardown always runs
// ---------------------------------------------------------------------------

describe("#1915 — destroy-throw cleanup ordering", () => {
  test("unexpected destroy error does not skip post-destroy cleanup", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("simulated wgpu native crash during teardown");
      },
    };
    let cleanupRan = false;
    const actions = (): void => {
      cleanupRan = true;
    };
    expect(() => destroyThenCleanupThenRethrow(fakeRenderer, actions)).toThrow("simulated wgpu");
    expect(cleanupRan).toBe(true);
  });

  test("suppressed stdin-fd-invalid error still runs cleanup and does not throw", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("setRawMode failed with errno: 2");
      },
    };
    let cleanupRan = false;
    const actions = (): void => {
      cleanupRan = true;
    };
    expect(() => destroyThenCleanupThenRethrow(fakeRenderer, actions)).not.toThrow();
    expect(cleanupRan).toBe(true);
  });

  test("successful destroy runs cleanup and does not throw", () => {
    const fakeRenderer = {
      destroy(): void {
        /* ok */
      },
    };
    let cleanupRan = false;
    const actions = (): void => {
      cleanupRan = true;
    };
    expect(() => destroyThenCleanupThenRethrow(fakeRenderer, actions)).not.toThrow();
    expect(cleanupRan).toBe(true);
  });
});
