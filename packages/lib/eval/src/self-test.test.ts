import { describe, expect, test } from "bun:test";
import { runSelfTest, SELF_TEST_ABORT_REASON } from "./self-test.js";
import type { SelfTestCheck } from "./types.js";

describe("runSelfTest", () => {
  test("aggregates pass when all checks pass", async () => {
    const checks: readonly SelfTestCheck[] = [
      { name: "a", run: () => ({ pass: true }) },
      { name: "b", run: async () => ({ pass: true }) },
    ];
    const result = await runSelfTest(checks);
    expect(result.pass).toBe(true);
    expect(result.checks).toHaveLength(2);
  });

  test("captures failure with message", async () => {
    const checks: readonly SelfTestCheck[] = [
      { name: "a", run: () => ({ pass: false, message: "broken" }) },
    ];
    const result = await runSelfTest(checks);
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.message).toBe("broken");
  });

  test("converts thrown error to failed check", async () => {
    const checks: readonly SelfTestCheck[] = [
      {
        name: "a",
        run: () => {
          throw new Error("crash");
        },
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.message).toContain("crash");
  });

  test("times out a slow check, reports cancellation: 'unconfirmed' for non-cooperative work", async () => {
    const checks: readonly SelfTestCheck[] = [
      {
        name: "slow",
        run: () =>
          new Promise<{ pass: true }>((resolve) => setTimeout(() => resolve({ pass: true }), 5000)),
        timeoutMs: 10,
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.message).toContain("timeout");
    expect(result.checks[0]?.cancellation).toBe("unconfirmed");
  });

  test("unconfirmed cancellation stops the self-test sequence by default", async () => {
    let secondRan = false;
    const checks: readonly SelfTestCheck[] = [
      {
        name: "ignores-signal",
        run: () =>
          new Promise<{ pass: true }>((resolve) => setTimeout(() => resolve({ pass: true }), 50)),
        timeoutMs: 10,
      },
      {
        name: "should-not-run",
        run: () => {
          secondRan = true;
          return { pass: true };
        },
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.checks).toHaveLength(1);
    expect(secondRan).toBe(false);
  });

  test("late settlement without sentinel still reports cancellation: 'unconfirmed'", async () => {
    const checks: readonly SelfTestCheck[] = [
      {
        name: "ignores-signal",
        run: () =>
          new Promise<{ pass: true }>((resolve) => setTimeout(() => resolve({ pass: true }), 50)),
        timeoutMs: 10,
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.checks[0]?.cancellation).toBe("unconfirmed");
  });

  test("cooperative check that aborts on signal reports cancellation: 'confirmed'", async () => {
    const checks: readonly SelfTestCheck[] = [
      {
        name: "cooperative",
        run: (signal) =>
          new Promise<{ pass: false; message: string }>((resolve) => {
            const t = setTimeout(() => resolve({ pass: true, message: "" } as never), 5_000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve({ pass: false, message: SELF_TEST_ABORT_REASON });
            });
          }),
        timeoutMs: 10,
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.checks[0]?.cancellation).toBe("confirmed");
  });

  test("rejection with standard AbortError counts as confirmed cancellation", async () => {
    // Cooperative check that rejects with a third-party AbortError-like
    // error (fetch / streams / DB clients all do this). The previous
    // behavior required our private sentinel, which would mark every
    // spec-compliant cooperative check as `unconfirmed` and stop the
    // remaining checks.
    const checks: readonly SelfTestCheck[] = [
      {
        name: "abort-error",
        run: (signal) =>
          new Promise<{ pass: true }>((_, reject) => {
            signal.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
        timeoutMs: 10,
      },
      { name: "should-run", run: () => ({ pass: true }) },
    ];
    const result = await runSelfTest(checks);
    expect(result.checks[0]?.cancellation).toBe("confirmed");
    // Subsequent checks must still run because cancellation was confirmed.
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1]?.name).toBe("should-run");
  });

  test("non-abort rejection after timeout is reported as unconfirmed", async () => {
    // A check that times out and then rejects with an unrelated error
    // (programmer bug, network failure, etc.) must NOT be treated as
    // confirmed cancellation — the check may still be cleaning up
    // detached work, and letting the next check start could overlap
    // with leaked side effects.
    let secondRan = false;
    const checks: readonly SelfTestCheck[] = [
      {
        name: "unrelated-failure",
        run: () =>
          new Promise<{ pass: true }>((_, reject) => {
            setTimeout(() => reject(new Error("unrelated network failure")), 30);
          }),
        timeoutMs: 10,
      },
      {
        name: "should-not-run",
        run: () => {
          secondRan = true;
          return { pass: true };
        },
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.checks[0]?.cancellation).toBe("unconfirmed");
    expect(secondRan).toBe(false);
  });

  test("bail stops at first failure", async () => {
    let secondRan = false;
    const checks: readonly SelfTestCheck[] = [
      { name: "a", run: () => ({ pass: false }) },
      {
        name: "b",
        run: () => {
          secondRan = true;
          return { pass: true };
        },
      },
    ];
    const result = await runSelfTest(checks, { bail: true });
    expect(result.checks).toHaveLength(1);
    expect(secondRan).toBe(false);
  });

  test("records duration per check", async () => {
    const result = await runSelfTest([{ name: "a", run: () => ({ pass: true }) }]);
    expect(result.checks[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
