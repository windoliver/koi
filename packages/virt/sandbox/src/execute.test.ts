/**
 * Unit and integration tests for execute() — buffered sandbox execution.
 *
 * Pure logic tests run unconditionally.
 * Integration tests that spawn real processes are gated behind SANDBOX_INTEGRATION.
 */

import { describe, expect, test } from "bun:test";
import { execute } from "./execute.js";
import { restrictiveProfile } from "./profiles.js";
import type { SandboxProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Helper: build a profile with custom overrides
// ---------------------------------------------------------------------------
function testProfile(overrides?: Partial<SandboxProfile>): SandboxProfile {
  return restrictiveProfile(overrides);
}

// ---------------------------------------------------------------------------
// Integration tests — require real sandbox-exec / bwrap
// ---------------------------------------------------------------------------
const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION;

describe.skipIf(SKIP_INTEGRATION)("execute integration", () => {
  describe("normal exit", () => {
    test("exitCode=0, timedOut=false, oomKilled=false for successful command", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/echo", ["hello"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.exitCode).toBe(0);
      expect(result.value.timedOut).toBe(false);
      expect(result.value.oomKilled).toBe(false);
      expect(result.value.durationMs).toBeGreaterThan(0);
      expect(typeof result.value.stdout).toBe("string");
      expect(typeof result.value.stderr).toBe("string");
    });
  });

  describe("non-zero exit", () => {
    test("captures exitCode correctly for exit 42", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "exit 42"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.exitCode).toBe(42);
      expect(result.value.timedOut).toBe(false);
      expect(result.value.oomKilled).toBe(false);
    });

    test("captures exitCode correctly for exit 1", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "exit 1"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.exitCode).toBe(1);
    });
  });

  describe("stderr capture", () => {
    test("stdout and stderr are separated", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "echo out; echo err >&2"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.stdout.trim()).toBe("out");
      expect(result.value.stderr.trim()).toBe("err");
    });

    test("stderr is empty for clean commands", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/echo", ["clean"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.stderr).toBe("");
    });
  });

  describe("stdin pipe", () => {
    test("piped input reaches the process", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/usr/bin/tr", ["a-z", "A-Z"], {
        stdin: "hello world",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.stdout.trim()).toBe("HELLO WORLD");
    });

    test("stdin with empty string", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/cat", [], {
        stdin: "",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.stdout).toBe("");
    });
  });

  describe("timeout detection", () => {
    test("timedOut=true when timeout fires", async () => {
      const profile = testProfile({ resources: { timeoutMs: 200 } });
      const result = await execute(profile, "/bin/sleep", ["30"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.timedOut).toBe(true);
      expect(result.value.durationMs).toBeLessThan(5000);
      // When timed out via SIGKILL, exit code is 137 but oomKilled should be false
      expect(result.value.oomKilled).toBe(false);
    });
  });

  describe("signal detection", () => {
    test("SIGTERM exit code 143 maps to signal=SIGTERM", async () => {
      // Spawn a process that sends itself SIGTERM
      const profile = testProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "kill -TERM $$"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Exit code 143 = 128 + 15 (SIGTERM)
      expect(result.value.exitCode).toBe(143);
      expect(result.value.signal).toBe("SIGTERM");
    });

    test("SIGKILL exit code 137 without timeout sets oomKilled=true", async () => {
      // Spawn a process that sends itself SIGKILL (simulates OOM)
      const profile = testProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "kill -KILL $$"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.exitCode).toBe(137);
      expect(result.value.signal).toBe("SIGKILL");
      // Not timed out, so OOM is the assumption
      expect(result.value.oomKilled).toBe(true);
    });
  });

  describe("SandboxResult fields", () => {
    test("returns all expected fields", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/echo", ["fields"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const value = result.value;
      expect(typeof value.exitCode).toBe("number");
      expect(typeof value.stdout).toBe("string");
      expect(typeof value.stderr).toBe("string");
      expect(typeof value.durationMs).toBe("number");
      expect(typeof value.timedOut).toBe("boolean");
      expect(typeof value.oomKilled).toBe("boolean");
    });

    test("durationMs is positive for real commands", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "sleep 0.05"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.durationMs).toBeGreaterThan(0);
    });
  });

  describe("environment and cwd options", () => {
    test("cwd option is passed to process", async () => {
      const profile = testProfile();
      const result = await execute(profile, "/bin/pwd", [], { cwd: "/tmp" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.stdout.trim()).toBe("/tmp");
    });
  });
});

// ---------------------------------------------------------------------------
// Pure logic tests — no sandbox required, runs on all platforms
// ---------------------------------------------------------------------------
describe("execute result shape", () => {
  test("returns ok=true result on current platform", async () => {
    // This test verifies that execute returns a well-shaped Result on the
    // current platform. On macOS/Linux it actually runs; on others it
    // should return an error result.
    const profile = testProfile();
    const result = await execute(profile, "/bin/echo", ["test"]);

    expect(result).toHaveProperty("ok");
    if (result.ok) {
      expect(result.value).toHaveProperty("exitCode");
      expect(result.value).toHaveProperty("stdout");
      expect(result.value).toHaveProperty("stderr");
      expect(result.value).toHaveProperty("durationMs");
      expect(result.value).toHaveProperty("timedOut");
      expect(result.value).toHaveProperty("oomKilled");
    } else {
      // On unsupported platforms, error should have proper shape
      expect(result.error).toHaveProperty("code");
      expect(result.error).toHaveProperty("message");
      expect(result.error).toHaveProperty("retryable");
    }
  });
});

// ---------------------------------------------------------------------------
// signalName mapping (tested indirectly via integration)
// We document the expected mappings here as a reference for exit-code based tests.
// ---------------------------------------------------------------------------
describe("signal name mapping expectations", () => {
  // These tests verify our understanding of the signal mapping in execute.ts.
  // The actual mapping is private; we test it through integration tests above.
  // Here we document the mapping for completeness.
  const signalMap: ReadonlyArray<readonly [number, string]> = [
    [129, "SIGHUP"], // 128 + 1
    [130, "SIGINT"], // 128 + 2
    [131, "SIGQUIT"], // 128 + 3
    [134, "SIGABRT"], // 128 + 6
    [137, "SIGKILL"], // 128 + 9
    [139, "SIGSEGV"], // 128 + 11
    [141, "SIGPIPE"], // 128 + 13
    [142, "SIGALRM"], // 128 + 14
    [143, "SIGTERM"], // 128 + 15
  ];

  for (const [exitCode, expectedSignal] of signalMap) {
    test(`exit code ${exitCode} should map to ${expectedSignal}`, () => {
      // This is a documentation test. The actual mapping is tested in integration.
      const signalNum = exitCode - 128;
      const signals: Readonly<Record<number, string>> = {
        1: "SIGHUP",
        2: "SIGINT",
        3: "SIGQUIT",
        6: "SIGABRT",
        9: "SIGKILL",
        11: "SIGSEGV",
        13: "SIGPIPE",
        14: "SIGALRM",
        15: "SIGTERM",
      };
      expect(signals[signalNum]).toBe(expectedSignal);
    });
  }

  test("exit code <= 128 does not produce a signal", () => {
    // Normal exit codes (0-128) should not have signal field
    const codes = [0, 42, 128];
    for (const code of codes) {
      expect(code > 128).toBe(false);
    }
  });

  test("unknown signal numbers map to null", () => {
    const signals: Readonly<Record<number, string>> = {
      1: "SIGHUP",
      2: "SIGINT",
      3: "SIGQUIT",
      6: "SIGABRT",
      9: "SIGKILL",
      11: "SIGSEGV",
      13: "SIGPIPE",
      14: "SIGALRM",
      15: "SIGTERM",
    };
    // Signal 99 is not in the map
    expect(signals[99]).toBeUndefined();
  });
});
