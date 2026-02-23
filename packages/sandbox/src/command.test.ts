/**
 * Unit tests for buildSandboxCommand() — shared sandbox command construction.
 */

import { describe, expect, test } from "bun:test";
import { buildSandboxCommand } from "./command.js";
import { restrictiveProfile } from "./profiles.js";

describe("buildSandboxCommand", () => {
  const profile = restrictiveProfile();

  test("returns ok result with executable and args on supported platform", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.value.executable).toBe("string");
    expect(result.value.executable.length).toBeGreaterThan(0);
    expect(Array.isArray(result.value.args)).toBe(true);
  });

  test("macOS uses sandbox-exec as executable", () => {
    if (process.platform !== "darwin") return;

    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executable).toBe("sandbox-exec");
    // Args should contain -p flag and the command
    expect(result.value.args).toContain("/bin/echo");
  });

  test("Linux uses bwrap as executable", () => {
    if (process.platform !== "linux") return;

    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executable).toBe("bwrap");
    // Command may be embedded in a ulimit wrapper (sh -c "...") when
    // profile has resource limits, so check the joined args string.
    const allArgs = result.value.args.join(" ");
    expect(allArgs).toContain("/bin/echo");
  });

  test("includes command arguments in output", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", ["arg1", "arg2"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Args may be direct array elements (macOS seatbelt) or embedded
    // in a ulimit wrapper string (Linux bwrap with resource limits).
    const allArgs = result.value.args.join(" ");
    expect(allArgs).toContain("arg1");
    expect(allArgs).toContain("arg2");
  });

  test("returns well-formed error on unsupported platform", () => {
    // This test verifies the error shape; actual platform detection is tested
    // in detect.test.ts. On macOS/Linux this test just verifies success path.
    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result).toHaveProperty("ok");
    if (!result.ok) {
      expect(result.error).toHaveProperty("code");
      expect(result.error).toHaveProperty("message");
      expect(result.error).toHaveProperty("retryable");
    }
  });

  test("empty args array produces valid command", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executable.length).toBeGreaterThan(0);
  });
});
