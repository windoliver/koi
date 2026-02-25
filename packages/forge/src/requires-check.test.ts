import { describe, expect, test } from "bun:test";
import type { BrickRequires } from "@koi/core";
import { checkBrickRequires } from "./requires-check.js";

describe("checkBrickRequires", () => {
  test("returns satisfied when requires is undefined", () => {
    const result = checkBrickRequires(undefined, new Set());
    expect(result.satisfied).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  test("returns satisfied when all requirements are met", () => {
    const requires: BrickRequires = {
      // "bun" should be available in test environment
      bins: ["bun"],
      env: ["PATH"],
      tools: ["myTool"],
    };
    const result = checkBrickRequires(requires, new Set(["myTool"]));
    expect(result.satisfied).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  test("returns violation for missing binary", () => {
    const requires: BrickRequires = {
      bins: ["__nonexistent_binary_xyz_123__"],
    };
    const result = checkBrickRequires(requires, new Set());
    expect(result.satisfied).toBe(false);
    expect(result.violation).toEqual({ kind: "bin", name: "__nonexistent_binary_xyz_123__" });
  });

  test("returns violation for missing env var", () => {
    const requires: BrickRequires = {
      env: ["__KOI_NONEXISTENT_ENV_VAR_XYZ__"],
    };
    const result = checkBrickRequires(requires, new Set());
    expect(result.satisfied).toBe(false);
    expect(result.violation).toEqual({ kind: "env", name: "__KOI_NONEXISTENT_ENV_VAR_XYZ__" });
  });

  test("returns violation for missing tool", () => {
    const requires: BrickRequires = {
      tools: ["nonexistentTool"],
    };
    const result = checkBrickRequires(requires, new Set(["otherTool"]));
    expect(result.satisfied).toBe(false);
    expect(result.violation).toEqual({ kind: "tool", name: "nonexistentTool" });
  });

  test("returns satisfied with empty requires object", () => {
    const requires: BrickRequires = {};
    const result = checkBrickRequires(requires, new Set());
    expect(result.satisfied).toBe(true);
  });

  test("checks bins before env before tools (fail-fast order)", () => {
    const requires: BrickRequires = {
      bins: ["__nonexistent_binary__"],
      env: ["__NONEXISTENT_ENV__"],
      tools: ["nonexistentTool"],
    };
    const result = checkBrickRequires(requires, new Set());
    // Should fail on bins first
    expect(result.satisfied).toBe(false);
    expect(result.violation?.kind).toBe("bin");
  });

  test("returns satisfied when only bins are specified and all present", () => {
    const requires: BrickRequires = {
      bins: ["bun"],
    };
    const result = checkBrickRequires(requires, new Set());
    expect(result.satisfied).toBe(true);
  });

  test("returns satisfied when only env is specified and present", () => {
    const requires: BrickRequires = {
      env: ["PATH"],
    };
    const result = checkBrickRequires(requires, new Set());
    expect(result.satisfied).toBe(true);
  });
});
