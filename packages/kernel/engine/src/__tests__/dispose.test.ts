import { describe, expect, test } from "bun:test";
import { disposeAll } from "../dispose.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDisposable(
  name: string,
  delayMs = 0,
  shouldThrow = false,
): AsyncDisposable & { readonly disposed: boolean; readonly name: string } {
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    get name() {
      return name;
    },
    async [Symbol.asyncDispose]() {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (shouldThrow) throw new Error(`${name} disposal failed`);
      disposed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("disposeAll", () => {
  test("disposes all services", async () => {
    const a = createDisposable("a");
    const b = createDisposable("b");
    const c = createDisposable("c");

    await disposeAll([a, b, c]);

    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(true);
    expect(c.disposed).toBe(true);
  });

  test("disposes in parallel (not sequential)", async () => {
    const start = Date.now();
    const a = createDisposable("a", 50);
    const b = createDisposable("b", 50);
    const c = createDisposable("c", 50);

    await disposeAll([a, b, c]);

    const elapsed = Date.now() - start;
    // If sequential: ~150ms. If parallel: ~50ms
    expect(elapsed).toBeLessThan(120);
  });

  test("one failure does not block others", async () => {
    const a = createDisposable("a");
    const b = createDisposable("b", 0, true); // throws
    const c = createDisposable("c");

    // Should not throw — allSettled absorbs errors
    await disposeAll([a, b, c]);

    expect(a.disposed).toBe(true);
    // b threw, so disposed is false
    expect(b.disposed).toBe(false);
    expect(c.disposed).toBe(true);
  });

  test("timeout prevents hung disposable from blocking", async () => {
    const slow = createDisposable("slow", 5000); // 5 second delay
    const fast = createDisposable("fast");

    const start = Date.now();
    await disposeAll([slow, fast], 100); // 100ms timeout
    const elapsed = Date.now() - start;

    // Should complete in ~100ms (timeout), not 5000ms
    expect(elapsed).toBeLessThan(500);
    expect(fast.disposed).toBe(true);
    // slow timed out — may or may not have completed
  });

  test("empty array is a no-op", async () => {
    await disposeAll([]);
    // Should not throw
  });
});
