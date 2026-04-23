import { describe, expect, test } from "bun:test";
import { unwrapTimeout } from "./timeout.js";

describe("unwrapTimeout", () => {
  test("strips timeout DURATION and returns inner argv", () => {
    expect(unwrapTimeout(["timeout", "30", "curl", "http://example.com"])).toEqual({
      argv: ["curl", "http://example.com"],
      envVars: [],
    });
  });

  test("handles --preserve-status flag", () => {
    expect(unwrapTimeout(["timeout", "--preserve-status", "10", "sleep", "5"])).toEqual({
      argv: ["sleep", "5"],
      envVars: [],
    });
  });

  test("handles --foreground flag", () => {
    expect(unwrapTimeout(["timeout", "--foreground", "5s", "ls"])).toEqual({
      argv: ["ls"],
      envVars: [],
    });
  });

  test("handles -s SIG flag", () => {
    expect(unwrapTimeout(["timeout", "-s", "KILL", "10", "rm", "-rf", "/tmp"])).toEqual({
      argv: ["rm", "-rf", "/tmp"],
      envVars: [],
    });
  });

  test("handles -k DURATION (kill-after) flag", () => {
    expect(unwrapTimeout(["timeout", "-k", "5", "30", "sleep", "100"])).toEqual({
      argv: ["sleep", "100"],
      envVars: [],
    });
  });

  test("handles combined flags", () => {
    expect(unwrapTimeout(["timeout", "--preserve-status", "-s", "TERM", "60", "make"])).toEqual({
      argv: ["make"],
      envVars: [],
    });
  });

  test("returns null when no CMD after DURATION", () => {
    expect(unwrapTimeout(["timeout", "30"])).toBeNull();
  });

  test("returns null for bare timeout", () => {
    expect(unwrapTimeout(["timeout"])).toBeNull();
  });

  test("returns null for unknown flag — ambiguous, refuse", () => {
    expect(unwrapTimeout(["timeout", "-x", "10", "ls"])).toBeNull();
  });

  test("returns null for non-timeout argv", () => {
    expect(unwrapTimeout(["sleep", "5"])).toBeNull();
  });
});
