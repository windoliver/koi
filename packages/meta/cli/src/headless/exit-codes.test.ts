import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { HEADLESS_EXIT, mapErrorToExitCode } from "./exit-codes.js";

function err(code: KoiError["code"]): KoiError {
  return { code, message: "x", retryable: false };
}

describe("HEADLESS_EXIT", () => {
  test("has the six documented exit codes", () => {
    expect(HEADLESS_EXIT.SUCCESS).toBe(0);
    expect(HEADLESS_EXIT.AGENT_FAILURE).toBe(1);
    expect(HEADLESS_EXIT.PERMISSION_DENIED).toBe(2);
    expect(HEADLESS_EXIT.BUDGET_EXCEEDED).toBe(3);
    expect(HEADLESS_EXIT.TIMEOUT).toBe(4);
    expect(HEADLESS_EXIT.INTERNAL).toBe(5);
  });
});

describe("mapErrorToExitCode", () => {
  test("undefined error → 0", () => {
    expect(mapErrorToExitCode(undefined)).toBe(HEADLESS_EXIT.SUCCESS);
  });

  test("PERMISSION → 2", () => {
    expect(mapErrorToExitCode(err("PERMISSION"))).toBe(2);
  });

  test("TIMEOUT → 4", () => {
    expect(mapErrorToExitCode(err("TIMEOUT"))).toBe(4);
  });

  test("INTERNAL → 5", () => {
    expect(mapErrorToExitCode(err("INTERNAL"))).toBe(5);
  });

  test("VALIDATION defaults to 1 (agent failure)", () => {
    expect(mapErrorToExitCode(err("VALIDATION"))).toBe(1);
  });

  test("NOT_FOUND defaults to 1 (agent failure)", () => {
    expect(mapErrorToExitCode(err("NOT_FOUND"))).toBe(1);
  });

  test("raw Error (not KoiError) → 5", () => {
    expect(mapErrorToExitCode(new Error("boom"))).toBe(5);
  });

  test("null / non-object → 5", () => {
    expect(mapErrorToExitCode(null)).toBe(5);
    expect(mapErrorToExitCode("string error")).toBe(5);
  });
});
