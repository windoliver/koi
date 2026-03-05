import { describe, expect, test } from "bun:test";
import { resolveGoalStackConfig } from "../config-resolution.js";

describe("resolveGoalStackConfig", () => {
  test("defaults to standard preset", () => {
    const result = resolveGoalStackConfig({
      objectives: ["Build feature"],
    });
    expect(result.preset).toBe("standard");
  });

  test("standard without objectives throws", () => {
    expect(() => resolveGoalStackConfig({})).toThrow(/requires non-empty objectives/);
  });

  test("standard with empty objectives throws", () => {
    expect(() => resolveGoalStackConfig({ objectives: [] })).toThrow(
      /requires non-empty objectives/,
    );
  });

  test("error message mentions minimal as alternative", () => {
    expect(() => resolveGoalStackConfig({ preset: "standard" })).toThrow(/minimal/);
  });

  test("autonomous without objectives throws", () => {
    expect(() => resolveGoalStackConfig({ preset: "autonomous" })).toThrow(
      /requires non-empty objectives/,
    );
  });

  test("minimal without objectives succeeds", () => {
    const result = resolveGoalStackConfig({ preset: "minimal" });
    expect(result.preset).toBe("minimal");
  });

  test("minimal with empty objectives succeeds", () => {
    const result = resolveGoalStackConfig({
      preset: "minimal",
      objectives: [],
    });
    expect(result.preset).toBe("minimal");
  });

  test("passes through user config unchanged", () => {
    const config = {
      preset: "autonomous" as const,
      objectives: ["Task A"],
      anchor: { header: "Custom" },
    };
    const result = resolveGoalStackConfig(config);
    expect(result.config).toBe(config);
  });
});
