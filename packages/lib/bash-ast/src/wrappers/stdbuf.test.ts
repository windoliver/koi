import { describe, expect, test } from "bun:test";
import { unwrapStdbuf } from "./stdbuf.js";

describe("unwrapStdbuf", () => {
  test("strips stdbuf -o L and returns inner argv", () => {
    expect(unwrapStdbuf(["stdbuf", "-o", "L", "grep", "foo"])).toEqual({
      argv: ["grep", "foo"],
      envVars: [],
    });
  });

  test("handles all three buffer flags", () => {
    expect(unwrapStdbuf(["stdbuf", "-i", "0", "-o", "0", "-e", "0", "cmd"])).toEqual({
      argv: ["cmd"],
      envVars: [],
    });
  });

  test("handles long --output=L flag", () => {
    expect(unwrapStdbuf(["stdbuf", "--output=L", "ls"])).toEqual({
      argv: ["ls"],
      envVars: [],
    });
  });

  test("handles long --input and --error flags", () => {
    expect(unwrapStdbuf(["stdbuf", "--input=0", "--error=0", "make"])).toEqual({
      argv: ["make"],
      envVars: [],
    });
  });

  test("returns null for bare stdbuf with no CMD", () => {
    expect(unwrapStdbuf(["stdbuf"])).toBeNull();
  });

  test("returns null when only flags and no CMD", () => {
    expect(unwrapStdbuf(["stdbuf", "-o", "L"])).toBeNull();
  });

  test("returns null for unknown flag — ambiguous, refuse", () => {
    expect(unwrapStdbuf(["stdbuf", "-x", "ls"])).toBeNull();
  });

  test("returns null for non-stdbuf argv", () => {
    expect(unwrapStdbuf(["ls", "-la"])).toBeNull();
  });
});
