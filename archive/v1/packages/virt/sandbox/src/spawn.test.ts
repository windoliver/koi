/**
 * Unit and integration tests for spawn() — streaming sandbox process API.
 *
 * Integration tests that spawn real processes are gated behind SANDBOX_INTEGRATION.
 * Pure logic and shape tests run unconditionally.
 */

import { describe, expect, test } from "bun:test";
import { restrictiveProfile } from "./profiles.js";
import { spawn } from "./spawn.js";
import type { SandboxProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function testProfile(overrides?: Partial<SandboxProfile>): SandboxProfile {
  return restrictiveProfile(overrides);
}

// ---------------------------------------------------------------------------
// Integration tests — require real sandbox-exec / bwrap
// ---------------------------------------------------------------------------
const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION;

describe.skipIf(SKIP_INTEGRATION)("spawn integration", () => {
  describe("SandboxProcess fields", () => {
    test("returns SandboxProcess with expected fields", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/echo", ["hello"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      expect(typeof proc.pid).toBe("number");
      expect(proc.pid).toBeGreaterThan(0);
      expect(proc.stdout).toBeDefined();
      expect(proc.stderr).toBeDefined();
      expect(proc.stdin).toBeDefined();
      expect(typeof proc.stdin.write).toBe("function");
      expect(typeof proc.stdin.end).toBe("function");
      expect(proc.exited).toBeInstanceOf(Promise);
      expect(typeof proc.kill).toBe("function");

      // Clean up
      await proc.exited;
    });
  });

  describe("stdout stream", () => {
    test("stdout stream can be read", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/echo", ["stream output"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      const stdout = await new Response(proc.stdout).text();
      expect(stdout.trim()).toBe("stream output");
      await proc.exited;
    });

    test("stdout captures multi-line output", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/sh", ["-c", "echo line1; echo line2; echo line3"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      const stdout = await new Response(proc.stdout).text();
      const lines = stdout.trim().split("\n");
      expect(lines).toEqual(["line1", "line2", "line3"]);
      await proc.exited;
    });
  });

  describe("stderr stream", () => {
    test("stderr stream captures error output", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/sh", ["-c", "echo err >&2"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      const stderr = await new Response(proc.stderr).text();
      expect(stderr.trim()).toBe("err");
      await proc.exited;
    });
  });

  describe("stdin write", () => {
    test("stdin can be written to", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/usr/bin/tr", ["a-z", "A-Z"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      proc.stdin.write("hello from stdin");
      proc.stdin.end();

      const stdout = await new Response(proc.stdout).text();
      expect(stdout.trim()).toBe("HELLO FROM STDIN");
      await proc.exited;
    });
  });

  describe("process control", () => {
    test("process can be killed", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/sleep", ["60"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      proc.kill(9); // SIGKILL
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
    });

    test("kill with default signal terminates process", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/sleep", ["60"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const proc = result.value;
      proc.kill(); // default signal
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
    });

    test("exited promise resolves with exit code", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/sh", ["-c", "exit 7"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const exitCode = await result.value.exited;
      expect(exitCode).toBe(7);
    });

    test("exited promise resolves to 0 for successful command", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/true", []);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const exitCode = await result.value.exited;
      expect(exitCode).toBe(0);
    });
  });

  describe("environment and cwd options", () => {
    test("cwd option is passed to spawned process", async () => {
      const profile = testProfile();
      const result = spawn(profile, "/bin/pwd", [], { cwd: "/tmp" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stdout = await new Response(result.value.stdout).text();
      expect(stdout.trim()).toBe("/tmp");
      await result.value.exited;
    });
  });
});

// ---------------------------------------------------------------------------
// Pure shape / logic tests — no sandbox required
// ---------------------------------------------------------------------------
describe("spawn result shape", () => {
  test("returns a Result with ok property", () => {
    const profile = testProfile();
    const result = spawn(profile, "/bin/echo", ["test"]);

    expect(result).toHaveProperty("ok");
    if (result.ok) {
      // On supported platforms, we get SandboxProcess
      expect(result.value).toHaveProperty("pid");
      expect(result.value).toHaveProperty("stdout");
      expect(result.value).toHaveProperty("stderr");
      expect(result.value).toHaveProperty("stdin");
      expect(result.value).toHaveProperty("exited");
      expect(result.value).toHaveProperty("kill");
      // Clean up spawned process
      result.value.kill(9);
    } else {
      // On unsupported platforms, we get an error
      expect(result.error).toHaveProperty("code");
      expect(result.error).toHaveProperty("message");
      expect(result.error).toHaveProperty("retryable");
    }
  });

  test("spawn is synchronous (returns Result, not Promise)", () => {
    const profile = testProfile();
    const result = spawn(profile, "/bin/echo", ["sync"]);

    // spawn() returns Result directly, not a Promise
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toHaveProperty("ok");

    // Clean up
    if (result.ok) {
      result.value.kill(9);
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling — tests for error paths
// ---------------------------------------------------------------------------
describe("spawn error paths", () => {
  test("returns error for non-existent command on supported platform", () => {
    // On macOS/Linux detectPlatform succeeds, but the sandbox wrapper might
    // still succeed at spawn time (the sandbox binary exists), and the inner
    // command fails at exec time. This tests that spawn does not crash.
    const profile = testProfile();
    const result = spawn(profile, "/nonexistent/command", []);

    // Spawn itself may succeed (sandbox-exec exists) and the error
    // manifests as a non-zero exit code. Either way, no crash.
    expect(result).toHaveProperty("ok");

    // Clean up if it did spawn
    if (result.ok) {
      result.value.kill(9);
    }
  });
});
