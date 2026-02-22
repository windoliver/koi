import { describe, expect, it } from "bun:test";
import { EXIT_CONFIG, EXIT_ERROR, EXIT_OK, EXIT_UNAVAILABLE } from "./exit-codes.js";

describe("exit codes", () => {
  it("EXIT_OK is 0", () => {
    expect(EXIT_OK).toBe(0);
  });

  it("EXIT_ERROR is 1", () => {
    expect(EXIT_ERROR).toBe(1);
  });

  it("EXIT_UNAVAILABLE is 69 (EX_UNAVAILABLE)", () => {
    expect(EXIT_UNAVAILABLE).toBe(69);
  });

  it("EXIT_CONFIG is 78 (EX_CONFIG)", () => {
    expect(EXIT_CONFIG).toBe(78);
  });

  it("all exit codes are unique", () => {
    const codes = [EXIT_OK, EXIT_ERROR, EXIT_UNAVAILABLE, EXIT_CONFIG];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
