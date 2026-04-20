import { describe, expect, test } from "bun:test";
import { posixBasename } from "./posix-basename.js";

describe("posixBasename — POSIX-style basename", () => {
  test("returns last segment for plain path", () => {
    expect(posixBasename("foo")).toEqual({ ok: true, value: "foo" });
    expect(posixBasename("a/b/foo.txt")).toEqual({ ok: true, value: "foo.txt" });
  });

  test("strips trailing slash before extracting", () => {
    expect(posixBasename("foo/")).toEqual({ ok: true, value: "foo" });
    expect(posixBasename("a/b/foo/")).toEqual({ ok: true, value: "foo" });
  });

  test("strips multiple trailing slashes", () => {
    expect(posixBasename("foo///")).toEqual({ ok: true, value: "foo" });
  });

  test("refuses root", () => {
    expect(posixBasename("/")).toEqual({ ok: false });
    expect(posixBasename("////")).toEqual({ ok: false });
  });

  test("refuses empty string", () => {
    expect(posixBasename("")).toEqual({ ok: false });
  });

  test("preserves absolute paths' basename", () => {
    expect(posixBasename("/etc/passwd")).toEqual({ ok: true, value: "passwd" });
    expect(posixBasename("/usr/local/")).toEqual({ ok: true, value: "local" });
  });

  test("handles single-segment relative paths with leading dot", () => {
    expect(posixBasename("./foo")).toEqual({ ok: true, value: "foo" });
    expect(posixBasename(".")).toEqual({ ok: true, value: "." });
  });
});
