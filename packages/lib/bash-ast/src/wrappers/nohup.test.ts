import { describe, expect, test } from "bun:test";
import { unwrapNohup } from "./nohup.js";

describe("unwrapNohup", () => {
  test("strips nohup and returns inner argv", () => {
    expect(unwrapNohup(["nohup", "rm", "-rf", "/tmp"])).toEqual({
      argv: ["rm", "-rf", "/tmp"],
      envVars: [],
    });
  });

  test("single inner command with no args", () => {
    expect(unwrapNohup(["nohup", "sleep"])).toEqual({ argv: ["sleep"], envVars: [] });
  });

  test("returns null for bare nohup with no inner command", () => {
    expect(unwrapNohup(["nohup"])).toBeNull();
  });

  test("returns null for non-nohup argv", () => {
    expect(unwrapNohup(["rm", "-rf", "/tmp"])).toBeNull();
  });

  test("returns null for empty argv", () => {
    expect(unwrapNohup([])).toBeNull();
  });
});
