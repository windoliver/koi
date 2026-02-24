import { describe, expect, test } from "bun:test";
import { mapFsError, mapParseError } from "../fs-errors.js";

/** Helper to create a fake FS error with a code property. */
function fsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("mapFsError", () => {
  test("maps ENOENT to NOT_FOUND", () => {
    const result = mapFsError(fsError("ENOENT", "no such file"), "/tmp/foo.json");
    expect(result.code).toBe("NOT_FOUND");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("/tmp/foo.json");
  });

  test("maps EACCES to PERMISSION", () => {
    const result = mapFsError(fsError("EACCES", "access denied"), "/etc/secret");
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("/etc/secret");
  });

  test("maps EPERM to PERMISSION", () => {
    const result = mapFsError(fsError("EPERM", "not permitted"), "/root/file");
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  test("maps EBUSY to TIMEOUT (retryable)", () => {
    const result = mapFsError(fsError("EBUSY", "file locked"), "/tmp/lock");
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("busy");
  });

  test("maps ENOSPC to INTERNAL", () => {
    const result = mapFsError(fsError("ENOSPC", "no space"), "/data/large");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps EISDIR to INTERNAL", () => {
    const result = mapFsError(fsError("EISDIR", "is a directory"), "/tmp/dir");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps ENOTDIR to INTERNAL", () => {
    const result = mapFsError(fsError("ENOTDIR", "not a directory"), "/tmp/file/child");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps ELOOP to INTERNAL", () => {
    const result = mapFsError(fsError("ELOOP", "too many symlinks"), "/tmp/loop");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps EIO to INTERNAL", () => {
    const result = mapFsError(fsError("EIO", "i/o error"), "/dev/sda1");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps unknown code to INTERNAL", () => {
    const result = mapFsError(fsError("EUNKNOWN", "weird"), "/tmp/what");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("EUNKNOWN");
  });

  test("handles error without code property", () => {
    const result = mapFsError(new Error("generic"), "/tmp/file");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("unknown");
  });

  test("handles non-Error input", () => {
    const result = mapFsError("string error", "/tmp/file");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("handles null input", () => {
    const result = mapFsError(null, "/tmp/file");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });
});

describe("mapParseError", () => {
  test("returns INTERNAL with file path in message", () => {
    const result = mapParseError(new SyntaxError("unexpected token"), "/data/brick.json");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("/data/brick.json");
    expect(result.message).toContain("Corrupted");
  });

  test("includes cause", () => {
    const cause = new Error("parse fail");
    const result = mapParseError(cause, "/tmp/bad.json");
    expect(result.cause).toBe(cause);
  });
});
