import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanStalePid, isProcessAlive, readPid, removePid, writePid } from "./pid-manager.js";

describe("pid-manager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexus-embed-pid-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("readPid", () => {
    test("returns PID when file exists and contains valid number", () => {
      writeFileSync(join(tempDir, "nexus.pid"), "12345");
      const pid = readPid(tempDir);
      expect(pid).toBe(12345);
    });

    test("returns undefined when PID file does not exist", () => {
      const pid = readPid(tempDir);
      expect(pid).toBeUndefined();
    });

    test("returns undefined for corrupt PID file with non-numeric content", () => {
      writeFileSync(join(tempDir, "nexus.pid"), "not-a-number");
      const pid = readPid(tempDir);
      expect(pid).toBeUndefined();
    });

    test("returns undefined for PID file with negative number", () => {
      writeFileSync(join(tempDir, "nexus.pid"), "-1");
      const pid = readPid(tempDir);
      expect(pid).toBeUndefined();
    });

    test("returns undefined for PID file with zero", () => {
      writeFileSync(join(tempDir, "nexus.pid"), "0");
      const pid = readPid(tempDir);
      expect(pid).toBeUndefined();
    });

    test("trims whitespace from PID file content", () => {
      writeFileSync(join(tempDir, "nexus.pid"), "  42  \n");
      const pid = readPid(tempDir);
      expect(pid).toBe(42);
    });
  });

  describe("writePid", () => {
    test("writes PID to file", () => {
      writePid(tempDir, 99999);
      const content = readFileSync(join(tempDir, "nexus.pid"), "utf-8");
      expect(content).toBe("99999");
    });

    test("creates directories if needed", () => {
      const nested = join(tempDir, "deep", "nested");
      writePid(nested, 12345);
      const content = readFileSync(join(nested, "nexus.pid"), "utf-8");
      expect(content).toBe("12345");
    });
  });

  describe("removePid", () => {
    test("removes existing PID file", () => {
      writeFileSync(join(tempDir, "nexus.pid"), "12345");
      removePid(tempDir);
      const pid = readPid(tempDir);
      expect(pid).toBeUndefined();
    });

    test("handles missing PID file gracefully", () => {
      // Should not throw
      expect(() => removePid(tempDir)).not.toThrow();
    });
  });

  describe("isProcessAlive", () => {
    test("returns true for current process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    test("returns false for non-existent PID", () => {
      // PID 999999 is very unlikely to exist
      expect(isProcessAlive(999999)).toBe(false);
    });
  });

  describe("cleanStalePid", () => {
    test("returns false when no PID file exists", () => {
      expect(cleanStalePid(tempDir)).toBe(false);
    });

    test("returns false when process is alive", () => {
      writePid(tempDir, process.pid);
      expect(cleanStalePid(tempDir)).toBe(false);
      // PID file should still exist
      expect(readPid(tempDir)).toBe(process.pid);
    });

    test("returns true and removes file when process is dead", () => {
      // Use a PID that's almost certainly dead
      writePid(tempDir, 999999);
      expect(cleanStalePid(tempDir)).toBe(true);
      // PID file should be gone
      expect(readPid(tempDir)).toBeUndefined();
    });
  });
});
