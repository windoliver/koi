import { describe, expect, test } from "bun:test";
import { spawn } from "../index.js";
import { restrictiveProfile } from "../profiles.js";

const SKIP = !process.env.SANDBOX_INTEGRATION;

describe.skipIf(SKIP)("spawn integration", () => {
  describe.skipIf(process.platform !== "darwin")("macOS seatbelt", () => {
    test("spawns and reads stdout stream", async () => {
      const profile = restrictiveProfile();
      const result = spawn(profile, "/bin/echo", ["hello spawn"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const proc = result.value;
        expect(proc.pid).toBeGreaterThan(0);
        const stdout = await new Response(proc.stdout).text();
        expect(stdout.trim()).toBe("hello spawn");
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
      }
    });

    test("spawns and writes to stdin", async () => {
      const profile = restrictiveProfile();
      const result = spawn(profile, "/usr/bin/tr", ["a-z", "A-Z"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const proc = result.value;
        proc.stdin.write("hello");
        proc.stdin.end();
        const stdout = await new Response(proc.stdout).text();
        expect(stdout.trim()).toBe("HELLO");
        await proc.exited;
      }
    });

    test("kill terminates process", async () => {
      const profile = restrictiveProfile();
      const result = spawn(profile, "/bin/sleep", ["60"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const proc = result.value;
        proc.kill(9);
        const exitCode = await proc.exited;
        // SIGKILL should produce exit code 137 or similar
        expect(exitCode).not.toBe(0);
      }
    });

    test("exited promise resolves with exit code", async () => {
      const profile = restrictiveProfile();
      const result = spawn(profile, "/bin/sh", ["-c", "exit 7"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const exitCode = await result.value.exited;
        expect(exitCode).toBe(7);
      }
    });
  });

  describe.skipIf(process.platform !== "linux")("linux bwrap", () => {
    test("spawns and reads stdout stream", async () => {
      const profile = restrictiveProfile();
      const result = spawn(profile, "/bin/echo", ["hello spawn"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const stdout = await new Response(result.value.stdout).text();
        expect(stdout.trim()).toBe("hello spawn");
        await result.value.exited;
      }
    });

    test("kill terminates process", async () => {
      const profile = restrictiveProfile();
      const result = spawn(profile, "/bin/sleep", ["60"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        result.value.kill(9);
        const exitCode = await result.value.exited;
        expect(exitCode).not.toBe(0);
      }
    });
  });
});
