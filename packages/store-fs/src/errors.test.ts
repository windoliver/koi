import { describe, expect, test } from "bun:test";
import { mapFsError, mapParseError } from "./errors.js";

describe("mapFsError", () => {
  test("ENOENT maps to NOT_FOUND", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("NOT_FOUND");
    expect(result.message).toContain("test.json");
  });

  test("EACCES maps to PERMISSION", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("PERMISSION");
  });

  test("EPERM maps to PERMISSION", () => {
    const err = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("PERMISSION");
  });

  test("ENOSPC maps to INTERNAL", () => {
    const err = Object.assign(new Error("no space left"), { code: "ENOSPC" });
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("Disk full");
  });

  test("EISDIR maps to INTERNAL", () => {
    const err = Object.assign(new Error("is a directory"), { code: "EISDIR" });
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("directory");
  });

  test("unknown error maps to INTERNAL", () => {
    const err = new Error("something else");
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("INTERNAL");
    expect(result.cause).toBe(err);
  });

  test("non-Error object with code", () => {
    const err = { code: "ENOENT", message: "not found" };
    const result = mapFsError(err, "test.json");
    expect(result.code).toBe("NOT_FOUND");
  });
});

describe("mapParseError", () => {
  test("wraps parse error as INTERNAL", () => {
    const err = new SyntaxError("Unexpected token");
    const result = mapParseError(err, "/store/ab/abc.json");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("Corrupted");
    expect(result.message).toContain("abc.json");
    expect(result.cause).toBe(err);
  });
});
