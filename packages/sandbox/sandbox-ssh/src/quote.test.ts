import { describe, expect, test } from "bun:test";
import { composeCommandLine, quoteArg } from "./quote.js";

describe("quoteArg", () => {
  test("empty string becomes '' literal", () => {
    expect(quoteArg("")).toBe("''");
  });

  test("simple word is single-quoted", () => {
    expect(quoteArg("hello")).toBe("'hello'");
  });

  test("argument containing spaces is single-quoted intact", () => {
    expect(quoteArg("hello world")).toBe("'hello world'");
  });

  test("internal single quote is escaped via close-escape-reopen", () => {
    expect(quoteArg("it's")).toBe("'it'\\''s'");
  });

  test("shell metacharacters do not escape the quote", () => {
    expect(quoteArg("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(quoteArg("`whoami`")).toBe("'`whoami`'");
    expect(quoteArg("a;b|c&d")).toBe("'a;b|c&d'");
  });
});

describe("composeCommandLine", () => {
  test("command with no args quotes only the command", () => {
    expect(composeCommandLine("ls", [])).toBe("'ls'");
  });

  test("command with simple args is space-joined and quoted", () => {
    expect(composeCommandLine("echo", ["hello", "world"])).toBe("'echo' 'hello' 'world'");
  });

  test("metacharacters in args do not break out of quoting", () => {
    expect(composeCommandLine("echo", ["$(rm -rf /)"])).toBe("'echo' '$(rm -rf /)'");
  });

  test("internal quotes in args are escaped per quoteArg rules", () => {
    expect(composeCommandLine("echo", ["it's"])).toBe("'echo' 'it'\\''s'");
  });
});
