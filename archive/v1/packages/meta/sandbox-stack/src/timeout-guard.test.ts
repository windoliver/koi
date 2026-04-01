import { describe, expect, mock, test } from "bun:test";
import type { SandboxExecutor, SandboxResult } from "@koi/core";
import { createTimeoutGuardedExecutor } from "./timeout-guard.js";

function createMockExecutor(resultFn?: SandboxExecutor["execute"]): SandboxExecutor {
  return {
    execute: mock(
      resultFn ??
        ((_code, _input, _timeout) =>
          Promise.resolve({
            ok: true as const,
            value: { output: "ok", durationMs: 10 } satisfies SandboxResult,
          })),
    ),
  };
}

describe("createTimeoutGuardedExecutor", () => {
  test("passes through when within timeout", async () => {
    const inner = createMockExecutor();
    const guarded = createTimeoutGuardedExecutor(inner, 30_000);

    const result = await guarded.execute("echo ok", null, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("ok");
    }
  });

  test("clamps caller timeout to max", async () => {
    const inner = createMockExecutor();
    const guarded = createTimeoutGuardedExecutor(inner, 2000);

    await guarded.execute("cmd", null, 10_000);

    // The inner executor should receive the clamped timeout
    const callArgs = (inner.execute as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs?.[2]).toBe(2000);
  });

  test("uses caller timeout when less than max", async () => {
    const inner = createMockExecutor();
    const guarded = createTimeoutGuardedExecutor(inner, 30_000);

    await guarded.execute("cmd", null, 5000);

    const callArgs = (inner.execute as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs?.[2]).toBe(5000);
  });

  test("original executor result returned unchanged on success", async () => {
    const expectedResult = {
      ok: true as const,
      value: { output: { answer: 42 }, durationMs: 15 } satisfies SandboxResult,
    };

    const inner = createMockExecutor(() => Promise.resolve(expectedResult));
    const guarded = createTimeoutGuardedExecutor(inner, 30_000);

    const result = await guarded.execute("calc", null, 5000);

    expect(result).toEqual(expectedResult);
  });

  test("returns TIMEOUT error when inner exceeds timeout", async () => {
    const inner = createMockExecutor(
      () =>
        new Promise((resolve) => {
          // Simulate slow execution that will lose the race
          setTimeout(
            () =>
              resolve({
                ok: true as const,
                value: { output: "late", durationMs: 200 } satisfies SandboxResult,
              }),
            200,
          );
        }),
    );
    const guarded = createTimeoutGuardedExecutor(inner, 50);

    const result = await guarded.execute("slow", null, 50);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.durationMs).toBe(50);
    }
  });
});
