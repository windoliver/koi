import { describe, expect, test } from "bun:test";
import { parseFlags } from "./parse-flags.js";

const allow = {
  bool: new Set(["r", "R", "f", "i", "v"]),
  value: new Set(["t", "output"]),
};

describe("parseFlags — short-flag handling", () => {
  test("recognised single short bool flag", () => {
    const result = parseFlags(["rm", "-r", "foo"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("r")).toBe(true);
    expect(result.positionals).toEqual(["foo"]);
  });

  test("bundled short bool flags split correctly", () => {
    const result = parseFlags(["rm", "-rf", "foo"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("r")).toBe(true);
    expect(result.flags.get("f")).toBe(true);
    expect(result.positionals).toEqual(["foo"]);
  });

  test("short value flag with separate arg", () => {
    const result = parseFlags(["cp", "-t", "/dest", "src"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("t")).toBe("/dest");
    expect(result.positionals).toEqual(["src"]);
  });

  test("short value flag attached form", () => {
    const result = parseFlags(["cp", "-t/dest", "src"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("t")).toBe("/dest");
    expect(result.positionals).toEqual(["src"]);
  });

  test("short value flag attached form with alphabetic tail", () => {
    // -tabc parses as -t with value "abc" (chars after head are the value, not flags)
    const result = parseFlags(["cp", "-tabc"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("t")).toBe("abc");
    expect(result.positionals).toEqual([]);
  });
});

describe("parseFlags — long-flag handling", () => {
  test("long bool flag", () => {
    const result = parseFlags(["cmd", "--verbose", "x"], {
      bool: new Set(["verbose"]),
      value: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("verbose")).toBe(true);
  });

  test("long value flag with space", () => {
    const result = parseFlags(["cmd", "--output", "out.txt", "in"], {
      bool: new Set(),
      value: new Set(["output"]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("output")).toBe("out.txt");
    expect(result.positionals).toEqual(["in"]);
  });

  test("long value flag with =", () => {
    const result = parseFlags(["cmd", "--output=out.txt", "in"], {
      bool: new Set(),
      value: new Set(["output"]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("output")).toBe("out.txt");
  });
});

describe("parseFlags — `--` end-of-options", () => {
  test("everything after -- is positional", () => {
    const result = parseFlags(["rm", "-r", "--", "-foo", "-bar"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("r")).toBe(true);
    expect(result.positionals).toEqual(["-foo", "-bar"]);
  });
});

describe("parseFlags — refusals", () => {
  test("unknown short flag", () => {
    const result = parseFlags(["rm", "-z", "foo"], allow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/unknown.*flag.*z/i);
  });

  test("unknown long flag", () => {
    const result = parseFlags(["cmd", "--zzz"], allow);
    expect(result.ok).toBe(false);
  });

  test("value flag missing its value", () => {
    const result = parseFlags(["cp", "-t"], allow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/missing value/i);
  });

  test("bundled short flag containing unknown rejects whole bundle", () => {
    const result = parseFlags(["rm", "-rz", "foo"], allow);
    expect(result.ok).toBe(false);
  });

  test("attached value form accepts all-bool-char value (POSIX -tf → t='f')", () => {
    // -t is a value flag; per POSIX every char after the head is the value,
    // even if the chars happen to coincide with bool-flag names.
    const result = parseFlags(["cp", "-tf", "x"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("t")).toBe("f");
    expect(result.positionals).toEqual(["x"]);
  });

  test("attached value -oLi (value chars match bool flags) accepted", () => {
    const result = parseFlags(["cmd", "-oLi"], {
      bool: new Set(["L", "i"]),
      value: new Set(["o"]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("o")).toBe("Li");
  });

  test("long value flag missing its value", () => {
    const result = parseFlags(["cmd", "--output"], { bool: new Set(), value: new Set(["output"]) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/missing value/i);
  });
});
