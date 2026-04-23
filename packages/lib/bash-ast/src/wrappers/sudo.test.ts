import { describe, expect, test } from "bun:test";
import { unwrapSudo } from "./sudo.js";

describe("unwrapSudo", () => {
  test("strips bare sudo and returns inner argv", () => {
    expect(unwrapSudo(["sudo", "rm", "-rf", "/tmp"])).toEqual({
      argv: ["rm", "-rf", "/tmp"],
      envVars: [],
    });
  });

  test("handles -u USER flag", () => {
    expect(unwrapSudo(["sudo", "-u", "root", "chown", "root", "/etc/foo"])).toEqual({
      argv: ["chown", "root", "/etc/foo"],
      envVars: [],
    });
  });

  test("handles -E flag (preserve env)", () => {
    expect(unwrapSudo(["sudo", "-E", "env"])).toEqual({ argv: ["env"], envVars: [] });
  });

  test("handles -H flag", () => {
    expect(unwrapSudo(["sudo", "-H", "ls"])).toEqual({ argv: ["ls"], envVars: [] });
  });

  test("handles -n flag (non-interactive)", () => {
    expect(unwrapSudo(["sudo", "-n", "ls"])).toEqual({ argv: ["ls"], envVars: [] });
  });

  test("handles combined flags -u USER and -E", () => {
    expect(unwrapSudo(["sudo", "-u", "deploy", "-E", "make", "install"])).toEqual({
      argv: ["make", "install"],
      envVars: [],
    });
  });

  test("handles -- separator", () => {
    expect(unwrapSudo(["sudo", "--", "rm", "-rf", "/tmp"])).toEqual({
      argv: ["rm", "-rf", "/tmp"],
      envVars: [],
    });
  });

  test("returns null for bare sudo with no inner command", () => {
    expect(unwrapSudo(["sudo"])).toBeNull();
  });

  test("returns null for sudo with only flags and no CMD", () => {
    expect(unwrapSudo(["sudo", "-E"])).toBeNull();
  });

  test("returns null for unknown flag — ambiguous, refuse", () => {
    expect(unwrapSudo(["sudo", "-Z", "ls"])).toBeNull();
  });

  test("returns null for non-sudo argv", () => {
    expect(unwrapSudo(["ls", "-la"])).toBeNull();
  });
});
