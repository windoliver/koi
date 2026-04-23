import { describe, expect, test } from "bun:test";
import { unwrapEnv } from "./env.js";

describe("unwrapEnv", () => {
  test("strips env and returns inner argv with no assignments", () => {
    expect(unwrapEnv(["env", "ls", "-la"])).toEqual({ argv: ["ls", "-la"], envVars: [] });
  });

  test("extracts NAME=VAL assignments as envVars", () => {
    expect(unwrapEnv(["env", "FOO=bar", "BAZ=qux", "node", "app.js"])).toEqual({
      argv: ["node", "app.js"],
      envVars: [
        { name: "FOO", value: "bar" },
        { name: "BAZ", value: "qux" },
      ],
    });
  });

  test("handles -i flag (ignore environment)", () => {
    expect(unwrapEnv(["env", "-i", "PATH=/bin", "sh"])).toEqual({
      argv: ["sh"],
      envVars: [{ name: "PATH", value: "/bin" }],
    });
  });

  test("handles -u NAME flag (unset variable)", () => {
    expect(unwrapEnv(["env", "-u", "FOO", "ls"])).toEqual({
      argv: ["ls"],
      envVars: [],
    });
  });

  test("handles -C DIR flag (chdir)", () => {
    expect(unwrapEnv(["env", "-C", "/tmp", "ls"])).toEqual({
      argv: ["ls"],
      envVars: [],
    });
  });

  test("assignment value may contain =", () => {
    expect(unwrapEnv(["env", "URL=http://x.com?a=1", "curl"])).toEqual({
      argv: ["curl"],
      envVars: [{ name: "URL", value: "http://x.com?a=1" }],
    });
  });

  test("returns null for bare env with no CMD", () => {
    expect(unwrapEnv(["env"])).toBeNull();
  });

  test("returns null for env with only assignments and no CMD", () => {
    expect(unwrapEnv(["env", "FOO=bar"])).toBeNull();
  });

  test("returns null for unknown flag — ambiguous, refuse", () => {
    expect(unwrapEnv(["env", "-S", "FOO=bar ls"])).toBeNull();
  });

  test("returns null for non-env argv", () => {
    expect(unwrapEnv(["ls", "-la"])).toBeNull();
  });
});
