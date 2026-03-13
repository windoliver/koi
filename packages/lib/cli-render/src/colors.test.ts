import { describe, expect, test } from "bun:test";
import { createColors } from "./colors.js";

describe("createColors", () => {
  test("enabled=true wraps text with ANSI codes", () => {
    const c = createColors(true);
    expect(c.red("error")).toBe("\x1b[31merror\x1b[39m");
    expect(c.green("ok")).toBe("\x1b[32mok\x1b[39m");
    expect(c.yellow("warn")).toBe("\x1b[33mwarn\x1b[39m");
    expect(c.blue("info")).toBe("\x1b[34minfo\x1b[39m");
    expect(c.cyan("note")).toBe("\x1b[36mnote\x1b[39m");
    expect(c.gray("debug")).toBe("\x1b[90mdebug\x1b[39m");
    expect(c.bold("strong")).toBe("\x1b[1mstrong\x1b[22m");
    expect(c.dim("faint")).toBe("\x1b[2mfaint\x1b[22m");
  });

  test("enabled=false returns plain text", () => {
    const c = createColors(false);
    expect(c.red("error")).toBe("error");
    expect(c.green("ok")).toBe("ok");
    expect(c.yellow("warn")).toBe("warn");
    expect(c.blue("info")).toBe("info");
    expect(c.cyan("note")).toBe("note");
    expect(c.gray("debug")).toBe("debug");
    expect(c.bold("strong")).toBe("strong");
    expect(c.dim("faint")).toBe("faint");
  });

  test("wraps empty string without error", () => {
    const c = createColors(true);
    expect(c.red("")).toBe("\x1b[31m\x1b[39m");
  });
});
