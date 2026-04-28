import { describe, expect, test } from "bun:test";
import { unwrapTime } from "./time.js";

describe("unwrapTime", () => {
  test("strips time and returns inner argv", () => {
    expect(unwrapTime(["time", "make", "build"])).toEqual({
      argv: ["make", "build"],
      envVars: [],
    });
  });

  test("strips time -p", () => {
    expect(unwrapTime(["time", "-p", "ls", "-la"])).toEqual({
      argv: ["ls", "-la"],
      envVars: [],
    });
  });

  test("strips time with -- separator", () => {
    expect(unwrapTime(["time", "--", "ls"])).toEqual({ argv: ["ls"], envVars: [] });
  });

  test("returns null for bare time with no inner command", () => {
    expect(unwrapTime(["time"])).toBeNull();
  });

  test("returns null for time with only flags and no CMD", () => {
    expect(unwrapTime(["time", "-p"])).toBeNull();
  });

  test("returns null for unknown flag — ambiguous, refuse", () => {
    expect(unwrapTime(["time", "-x", "ls"])).toBeNull();
  });

  test("returns null for non-time argv", () => {
    expect(unwrapTime(["ls", "-la"])).toBeNull();
  });
});
