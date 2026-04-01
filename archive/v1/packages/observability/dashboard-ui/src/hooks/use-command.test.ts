/**
 * Tests for use-command hook.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useCommand } from "./use-command.js";

// Minimal cleanup for hook tests
afterEach(() => {
  mock.restore();
});

describe("useCommand", () => {
  test("starts with idle state", () => {
    const action = mock(() => Promise.resolve());
    const { result } = renderHook(() => useCommand(action));

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("sets isExecuting during action and clears after", async () => {
    let resolve: () => void = () => {};
    const action = mock(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() => useCommand(action));

    // Start execution
    let executePromise: Promise<void>;
    act(() => {
      executePromise = result.current.execute();
    });

    expect(result.current.isExecuting).toBe(true);

    // Resolve the action
    await act(async () => {
      resolve();
      await executePromise;
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("captures error on failure", async () => {
    const expectedError = new Error("Network failure");
    const action = mock(() => Promise.reject(expectedError));
    const { result } = renderHook(() => useCommand(action));

    await act(async () => {
      try {
        await result.current.execute();
      } catch {
        // Expected to throw
      }
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe("Network failure");
  });

  test("wraps non-Error throwables into Error", async () => {
    const action = mock(() => Promise.reject("string error"));
    const { result } = renderHook(() => useCommand(action));

    await act(async () => {
      try {
        await result.current.execute();
      } catch {
        // Expected to throw
      }
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe("string error");
  });

  test("clears previous error on new execution", async () => {
    let shouldFail = true;
    const action = mock(() => {
      if (shouldFail) {
        return Promise.reject(new Error("first fail"));
      }
      return Promise.resolve();
    });

    const { result } = renderHook(() => useCommand(action));

    // First call fails
    await act(async () => {
      try {
        await result.current.execute();
      } catch {
        // Expected
      }
    });
    expect(result.current.error?.message).toBe("first fail");

    // Second call succeeds — error should be cleared
    shouldFail = false;
    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.error).toBeNull();
  });

  test("returns the result from the action", async () => {
    const action = mock(() => Promise.resolve({ retried: true }));
    const { result } = renderHook(() => useCommand(action));

    let returned: { readonly retried: boolean } | undefined;
    await act(async () => {
      returned = await result.current.execute();
    });

    expect(returned).toEqual({ retried: true });
  });
});
