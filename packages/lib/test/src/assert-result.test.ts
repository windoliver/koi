import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { assertErr, assertErrCode, assertOk } from "./assert-result.js";

const okResult: Result<number, KoiError> = { ok: true, value: 42 };
const errResult: Result<number, KoiError> = {
  ok: false,
  error: { code: "NOT_FOUND", message: "missing", retryable: false },
};

describe("assertOk", () => {
  test("passes through Ok", () => {
    assertOk(okResult);
    // After the assertion, value is accessible without narrowing
    expect(okResult.value).toBe(42);
  });

  test("throws on Err", () => {
    expect(() => assertOk(errResult)).toThrow(/expected Ok/);
  });
});

describe("assertErr", () => {
  test("passes through Err", () => {
    assertErr(errResult);
    expect(errResult.error.code).toBe("NOT_FOUND");
  });

  test("throws on Ok", () => {
    expect(() => assertErr(okResult)).toThrow(/expected Err/);
  });
});

describe("assertErrCode", () => {
  test("passes on matching code", () => {
    assertErrCode(errResult, "NOT_FOUND");
  });

  test("throws on mismatched code", () => {
    expect(() => assertErrCode(errResult, "VALIDATION")).toThrow(/expected code=VALIDATION/);
  });

  test("throws on Ok", () => {
    expect(() => assertErrCode(okResult, "VALIDATION")).toThrow(/expected Err/);
  });
});
