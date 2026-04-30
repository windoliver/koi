import { describe, expect, test } from "bun:test";
import { runSelfTest } from "./self-test.js";
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

  test("cooperative check that aborts on signal reports cancellation: 'confirmed'", async () => {
    const checks: readonly SelfTestCheck[] = [
      {
        name: "cooperative",
        run: (signal) =>
          new Promise<{ pass: false; message: string }>((resolve) => {
            const t = setTimeout(() => resolve({ pass: true, message: "" } as never), 5_000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve({ pass: false, message: "aborted" });
            });
          }),
        timeoutMs: 10,
      },
    ];
    const result = await runSelfTest(checks);
    expect(result.checks[0]?.cancellation).toBe("confirmed");
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
