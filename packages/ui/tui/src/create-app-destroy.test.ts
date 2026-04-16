/**
 * Regression test for #1770 — renderer.destroy() must not crash when
 * stdin fd is invalid (EBADF/ENOENT from setRawMode).
 *
 * The guard checks BOTH the errno code AND a setRawMode marker in the
 * message. This prevents swallowing unrelated ENOENT/EBADF errors from
 * other destroy paths (e.g. file cleanup, native renderer teardown).
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
    const isStdinRawModeError =
      e instanceof Error &&
      (errno === "EBADF" || errno === "ENOENT") &&
      /setRawMode|errno: 2/.test(e.message);
    if (!isStdinRawModeError) throw e;
  }
}

describe("renderer.destroy() error handling", () => {
  test("EBADF from setRawMode is suppressed during destroy", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("setRawMode failed with errno: 2");
        (err as NodeJS.ErrnoException).code = "EBADF";
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

  test("ENOENT variant with setRawMode marker is suppressed", () => {
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("ENOENT: no such file or directory, setRawMode");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      },
    };

    expect(() => destroyWithGuard(fakeRenderer)).not.toThrow();
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
});
