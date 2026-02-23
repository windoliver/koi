/**
 * Unit tests for buildSandboxCommand() — shared sandbox command construction.
 *
 * Tests cover:
 * 1. Happy path on current platform
 * 2. Command and args pass-through
 * 3. Empty args handling
 * 4. Unsupported platform error (via mock)
 * 5. Platform-specific executable selection
 */

import { describe, expect, test } from "bun:test";
import { buildSandboxCommand } from "./command.js";
import { restrictiveProfile } from "./profiles.js";

describe("buildSandboxCommand", () => {
  const profile = restrictiveProfile();
  const currentPlatform = process.platform;

  test("returns ok result with executable and args on supported platform", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.value.executable).toBe("string");
    expect(result.value.executable.length).toBeGreaterThan(0);
    expect(Array.isArray(result.value.args)).toBe(true);
  });

  test("macOS uses sandbox-exec as executable", () => {
    if (currentPlatform !== "darwin") return;

    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executable).toBe("sandbox-exec");
    expect(result.value.args).toContain("/bin/echo");
  });

  test("Linux uses bwrap as executable", () => {
    if (currentPlatform !== "linux") return;

    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executable).toBe("bwrap");
    const allArgs = result.value.args.join(" ");
    expect(allArgs).toContain("/bin/echo");
  });

  test("includes command arguments in output", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", ["arg1", "arg2"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const allArgs = result.value.args.join(" ");
    expect(allArgs).toContain("arg1");
    expect(allArgs).toContain("arg2");
  });

  test("empty args array produces valid command", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executable.length).toBeGreaterThan(0);
  });

  test("result error shape is well-formed on failure", () => {
    // Verify the error shape contract — on supported platforms this will
    // succeed, on unsupported platforms it will return a valid error.
    const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

    expect(result).toHaveProperty("ok");
    if (!result.ok) {
      expect(result.error).toHaveProperty("code");
      expect(result.error).toHaveProperty("message");
      expect(result.error).toHaveProperty("retryable");
    }
  });

  test("preserves command path in output args", () => {
    const result = buildSandboxCommand(profile, "/usr/local/bin/myapp", ["--flag", "value"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const allArgs = result.value.args.join(" ");
    expect(allArgs).toContain("/usr/local/bin/myapp");
    expect(allArgs).toContain("--flag");
    expect(allArgs).toContain("value");
  });

  test("args with spaces are preserved", () => {
    const result = buildSandboxCommand(profile, "/bin/echo", ["hello world", "foo bar"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // At least one arg should contain the space-containing values
    const hasSpacedArg = result.value.args.some(
      (a) => a.includes("hello world") || a.includes("foo bar"),
    );
    // On bwrap with ulimit wrapper, args may be in a shell string
    const allArgs = result.value.args.join("\0");
    const containsSpaced = allArgs.includes("hello world") || allArgs.includes("foo bar");
    expect(hasSpacedArg || containsSpaced).toBe(true);
  });

  test("unsupported platform returns VALIDATION error", () => {
    // Temporarily override process.platform to simulate unsupported OS
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      const result = buildSandboxCommand(profile, "/bin/echo", ["hello"]);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Unsupported platform");
      expect(result.error.message).toContain("win32");
      expect(result.error.retryable).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  test("different profile tiers produce valid commands", () => {
    // Test with a minimal profile (different tier)
    const minimalProfile = {
      ...profile,
      tier: "verified" as const,
    };

    const result = buildSandboxCommand(minimalProfile, "/bin/echo", ["test"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executable.length).toBeGreaterThan(0);
  });
});
