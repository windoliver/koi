import { describe, expect, test } from "bun:test";
import { execute } from "../index.js";
import { restrictiveProfile } from "../profiles.js";

const SKIP = !process.env.SANDBOX_INTEGRATION;

describe.skipIf(SKIP)("execute integration", () => {
  describe.skipIf(process.platform !== "darwin")("macOS seatbelt", () => {
    test("executes a simple command", async () => {
      const profile = restrictiveProfile();
      const result = await execute(profile, "/bin/echo", ["hello sandbox"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(0);
        expect(result.value.stdout.trim()).toBe("hello sandbox");
        expect(result.value.timedOut).toBe(false);
        expect(result.value.oomKilled).toBe(false);
      }
    });

    test("returns exit code for failing command", async () => {
      const profile = restrictiveProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "exit 42"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(42);
      }
    });

    test("timeout kills process", async () => {
      const profile = restrictiveProfile({ resources: { timeoutMs: 500 } });
      const result = await execute(profile, "/bin/sleep", ["10"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timedOut).toBe(true);
        expect(result.value.durationMs).toBeLessThan(5000);
      }
    });

    test("stdin is piped to process", async () => {
      const profile = restrictiveProfile();
      const result = await execute(profile, "/usr/bin/tr", ["a-z", "A-Z"], {
        stdin: "hello",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stdout.trim()).toBe("HELLO");
      }
    });

    test("captures stderr", async () => {
      const profile = restrictiveProfile();
      const result = await execute(profile, "/bin/sh", ["-c", "echo error >&2"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stderr.trim()).toBe("error");
      }
    });
  });

  describe.skipIf(process.platform !== "linux")("linux bwrap", () => {
    test("executes a simple command", async () => {
      const profile = restrictiveProfile();
      const result = await execute(profile, "/bin/echo", ["hello sandbox"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(0);
        expect(result.value.stdout.trim()).toBe("hello sandbox");
      }
    });

    test("timeout kills process", async () => {
      const profile = restrictiveProfile({ resources: { timeoutMs: 500 } });
      const result = await execute(profile, "/bin/sleep", ["10"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timedOut).toBe(true);
      }
    });
  });
});
