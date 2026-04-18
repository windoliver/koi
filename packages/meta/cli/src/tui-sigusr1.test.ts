import { describe, expect, test } from "bun:test";
import { constants as osConstants } from "node:os";
import { createSigusr1Handler, generateTuiStartupHint, SIGUSR1_EXIT_CODE } from "./tui-sigusr1.js";

describe("createSigusr1Handler", () => {
  test("invokes shutdown with SIGUSR1 exit code and a reason string", () => {
    const calls: Array<{ readonly code: number; readonly reason: string }> = [];
    const writes: string[] = [];
    const handler = createSigusr1Handler({
      shutdown: (code, reason) => calls.push({ code, reason }),
      write: (msg) => writes.push(msg),
    });

    handler();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).toBe(SIGUSR1_EXIT_CODE);
    expect(calls[0]?.reason).toContain("SIGUSR1");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("SIGUSR1 received");
  });

  test("is idempotent — repeated signals after the first do not re-trigger shutdown", () => {
    let shutdownCount = 0;
    const handler = createSigusr1Handler({
      shutdown: () => {
        shutdownCount += 1;
      },
      write: () => {},
    });

    handler();
    handler();
    handler();

    expect(shutdownCount).toBe(1);
  });

  test("swallows write errors and still calls shutdown (frozen stderr)", () => {
    let shutdownCalled = false;
    const handler = createSigusr1Handler({
      shutdown: () => {
        shutdownCalled = true;
      },
      write: () => {
        throw new Error("stderr closed");
      },
    });

    // A thrown write must not escape — otherwise the handler would crash
    // the process before the graceful shutdown could run.
    expect(() => handler()).not.toThrow();
    expect(shutdownCalled).toBe(true);
  });
});

describe("generateTuiStartupHint", () => {
  test("includes the pid and the kill command", () => {
    const hint = generateTuiStartupHint(12345);
    expect(hint).toContain("pid=12345");
    expect(hint).toContain("kill -USR1 12345");
    expect(hint.endsWith("\n")).toBe(true);
  });

  test("is pure — same pid yields same output", () => {
    expect(generateTuiStartupHint(42)).toBe(generateTuiStartupHint(42));
  });
});

describe("SIGUSR1_EXIT_CODE", () => {
  test("follows the canonical 128 + SIGUSR1 convention for the current platform", () => {
    // macOS assigns SIGUSR1 = 30 → 158; Linux assigns SIGUSR1 = 10 → 138.
    // Both are the conventional `128 + signum` a supervisor would compute
    // from an unhandled default-action exit.
    const expected = 128 + (osConstants.signals.SIGUSR1 ?? 30);
    expect(SIGUSR1_EXIT_CODE).toBe(expected);
  });

  test("is one of the known POSIX values (138 or 158)", () => {
    expect([138, 158]).toContain(SIGUSR1_EXIT_CODE);
  });
});
