import { describe, expect, test } from "bun:test";
import { compileGlob, matchAny } from "../glob.js";

describe("compileGlob", () => {
  test("`**` matches across separators", () => {
    const re = compileGlob("/scope/**");
    expect(re.test("/scope/")).toBe(true);
    expect(re.test("/scope/a/b/c.txt")).toBe(true);
    expect(re.test("/etc/passwd")).toBe(false);
  });

  test("`**/` allows zero leading segments", () => {
    const re = compileGlob("/scope/**/file.ts");
    expect(re.test("/scope/file.ts")).toBe(true);
    expect(re.test("/scope/a/file.ts")).toBe(true);
    expect(re.test("/scope/a/b/file.ts")).toBe(true);
    expect(re.test("/scope/a/file.txt")).toBe(false);
  });

  test("`*` does not cross separators", () => {
    const re = compileGlob("/scope/*.ts");
    expect(re.test("/scope/a.ts")).toBe(true);
    expect(re.test("/scope/a/b.ts")).toBe(false);
  });

  test("`?` matches exactly one non-separator", () => {
    const re = compileGlob("/k?y");
    expect(re.test("/key")).toBe(true);
    expect(re.test("/k/y")).toBe(false);
    expect(re.test("/keyy")).toBe(false);
  });

  test("escapes regex specials", () => {
    const re = compileGlob("/a.b+c$d");
    expect(re.test("/a.b+c$d")).toBe(true);
    expect(re.test("/aXb+c$d")).toBe(false);
  });

  test("anchors at both ends", () => {
    const re = compileGlob("/scope");
    expect(re.test("/scope")).toBe(true);
    expect(re.test("/scope/x")).toBe(false);
    expect(re.test("x/scope")).toBe(false);
  });
});

describe("matchAny", () => {
  test("returns true when any regex matches", () => {
    const regs = [compileGlob("/a/**"), compileGlob("/b/**")];
    expect(matchAny("/a/x", regs)).toBe(true);
    expect(matchAny("/b/y", regs)).toBe(true);
    expect(matchAny("/c/z", regs)).toBe(false);
  });

  test("returns false on empty list", () => {
    expect(matchAny("/anything", [])).toBe(false);
  });
});
