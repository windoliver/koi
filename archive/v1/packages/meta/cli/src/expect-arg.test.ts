import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EXIT_CONFIG } from "@koi/shutdown";
import { expectArg } from "./expect-arg.js";

describe("expectArg", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as unknown as (code?: number) => never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test("returns the value when defined", () => {
    const result = expectArg("my-brick", "name", "koi forge install <name>");
    expect(result).toBe("my-brick");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("exits with EXIT_CONFIG when value is undefined", () => {
    expect(() => expectArg(undefined, "name", "koi forge install <name>")).toThrow(
      "process.exit called",
    );
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CONFIG);
  });

  test("writes argument name to stderr when value is undefined", () => {
    try {
      expectArg(undefined, "query", "koi forge search <query>");
    } catch {
      // Expected — mocked process.exit throws
    }
    const output = stderrSpy.mock.calls.map((c: readonly unknown[]) => c[0]).join("");
    expect(output).toContain("query");
    expect(output).toContain("koi forge search <query>");
  });

  test("writes usage text to stderr", () => {
    try {
      expectArg(undefined, "brick-id", "koi forge publish <brick-id>");
    } catch {
      // Expected — mocked process.exit throws
    }
    const output = stderrSpy.mock.calls.map((c: readonly unknown[]) => c[0]).join("");
    expect(output).toContain("Usage: koi forge publish <brick-id>");
  });
});
