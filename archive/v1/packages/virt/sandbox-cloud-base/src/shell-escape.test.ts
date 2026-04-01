import { describe, expect, test } from "bun:test";
import { shellEscape, shellJoin } from "./shell-escape.js";

describe("shellEscape", () => {
  test("returns empty string as quoted empty", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("passes safe characters through unquoted", () => {
    expect(shellEscape("hello")).toBe("hello");
    expect(shellEscape("/usr/bin/node")).toBe("/usr/bin/node");
    expect(shellEscape("key=value")).toBe("key=value");
    expect(shellEscape("file.ts")).toBe("file.ts");
    expect(shellEscape("a-b_c.d")).toBe("a-b_c.d");
  });

  test("quotes arguments with spaces", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
    expect(shellEscape("path with spaces/file.ts")).toBe("'path with spaces/file.ts'");
  });

  test("quotes arguments with shell metacharacters", () => {
    expect(shellEscape("$(whoami)")).toBe("'$(whoami)'");
    expect(shellEscape("foo;rm -rf /")).toBe("'foo;rm -rf /'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("a&b")).toBe("'a&b'");
    expect(shellEscape("a`b`c")).toBe("'a`b`c'");
    expect(shellEscape('a"b"c')).toBe("'a\"b\"c'");
    expect(shellEscape("a*b")).toBe("'a*b'");
    expect(shellEscape("a?b")).toBe("'a?b'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  test("handles newlines and tabs", () => {
    expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
    expect(shellEscape("col1\tcol2")).toBe("'col1\tcol2'");
  });
});

describe("shellJoin", () => {
  test("returns command alone when no args", () => {
    expect(shellJoin("ls", [])).toBe("ls");
  });

  test("joins command with safe args", () => {
    expect(shellJoin("node", ["dist/server.js", "--port", "8080"])).toBe(
      "node dist/server.js --port 8080",
    );
  });

  test("escapes unsafe args in joined string", () => {
    expect(shellJoin("echo", ["hello world", "$(rm -rf /)"])).toBe(
      "echo 'hello world' '$(rm -rf /)'",
    );
  });

  test("escapes command with spaces", () => {
    expect(shellJoin("/usr/local/my app/bin", ["--flag"])).toBe("'/usr/local/my app/bin' --flag");
  });
});
