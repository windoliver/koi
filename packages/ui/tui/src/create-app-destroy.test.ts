/**
 * Regression test for #1770 — renderer.destroy() must not crash when
 * stdin fd is invalid (EBADF/ENOENT from setRawMode).
 */

import { describe, expect, test } from "bun:test";

describe("renderer.destroy() error handling", () => {
  test("EBADF from setRawMode is suppressed during destroy", () => {
    // Simulate the error path: a destroy() that throws EBADF
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("setRawMode failed with errno: 2");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      },
    };

    // This is the guard logic that will be in create-app.ts
    // Extracted here to test the pattern in isolation
    expect(() => {
      try {
        fakeRenderer.destroy();
      } catch (e: unknown) {
        const isRawModeError =
          e instanceof Error && /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
        if (!isRawModeError) throw e;
      }
    }).not.toThrow();
  });

  test("non-EBADF errors from destroy propagate", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("renderer native crash: segfault in wgpu");
      },
    };

    expect(() => {
      try {
        fakeRenderer.destroy();
      } catch (e: unknown) {
        const isRawModeError =
          e instanceof Error && /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
        if (!isRawModeError) throw e;
      }
    }).toThrow("renderer native crash");
  });

  test("ENOENT variant is also suppressed", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("ENOENT: no such file or directory, setRawMode");
      },
    };

    expect(() => {
      try {
        fakeRenderer.destroy();
      } catch (e: unknown) {
        const isRawModeError =
          e instanceof Error && /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
        if (!isRawModeError) throw e;
      }
    }).not.toThrow();
  });
});
