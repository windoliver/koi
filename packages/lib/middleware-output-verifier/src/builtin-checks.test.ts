import { describe, expect, test } from "bun:test";
import {
  BUILTIN_CHECKS,
  matchesPattern,
  maxLength,
  nonEmpty,
  validJson,
} from "./builtin-checks.js";

describe("nonEmpty", () => {
  test("passes for non-empty content", () => {
    const c = nonEmpty();
    expect(c.check("hello")).toBe(true);
  });

  test("fails for empty content with reason", () => {
    const c = nonEmpty();
    expect(c.check("")).toBe("Output must not be empty");
  });

  test("fails for whitespace-only content", () => {
    const c = nonEmpty();
    expect(c.check("   \n\t")).toBe("Output must not be empty");
  });

  test("default action is block", () => {
    expect(nonEmpty().action).toBe("block");
  });

  test("custom action is honored", () => {
    expect(nonEmpty("warn").action).toBe("warn");
  });
});

describe("maxLength", () => {
  test("passes when under limit", () => {
    const c = maxLength(10);
    expect(c.check("short")).toBe(true);
  });

  test("passes when at limit", () => {
    const c = maxLength(5);
    expect(c.check("12345")).toBe(true);
  });

  test("fails when over limit", () => {
    const c = maxLength(3);
    const result = c.check("12345");
    expect(typeof result).toBe("string");
    expect(result).toContain("3");
  });

  test("name encodes the limit", () => {
    expect(maxLength(42).name).toBe("max-length-42");
  });
});

describe("validJson", () => {
  test("passes for object", () => {
    expect(validJson().check('{"a": 1}')).toBe(true);
  });

  test("passes for array", () => {
    expect(validJson().check("[1, 2, 3]")).toBe(true);
  });

  test("fails for non-JSON text", () => {
    expect(validJson().check("not json")).toBe("Output must be valid JSON");
  });

  test("fails for malformed JSON", () => {
    expect(validJson().check('{"a":')).toBe("Output must be valid JSON");
  });
});

describe("matchesPattern", () => {
  test("passes when content matches", () => {
    const c = matchesPattern(/hello/);
    expect(c.check("hello world")).toBe(true);
  });

  test("fails when content does not match", () => {
    const c = matchesPattern(/^\d+$/);
    const result = c.check("abc");
    expect(typeof result).toBe("string");
  });

  test("uses default name from pattern source", () => {
    expect(matchesPattern(/foo/).name).toBe("matches-foo");
  });

  test("uses custom name when provided", () => {
    expect(matchesPattern(/x/, "block", "my-check").name).toBe("my-check");
  });

  test("repeated calls are deterministic with /g flag (lastIndex not mutated)", () => {
    // Without stripping the global flag, `RegExp.test()` would mutate
    // `lastIndex` and alternate true/false on the same input — turning
    // a deterministic verifier into a flaky veto.
    const c = matchesPattern(/foo/g);
    expect(c.check("foo")).toBe(true);
    expect(c.check("foo")).toBe(true);
    expect(c.check("foo")).toBe(true);
  });

  test("repeated calls are deterministic with /y sticky flag", () => {
    const c = matchesPattern(/foo/y);
    expect(c.check("foo")).toBe(true);
    expect(c.check("foo")).toBe(true);
  });
});

describe("BUILTIN_CHECKS registry", () => {
  test("exposes all four built-in checks", () => {
    expect(BUILTIN_CHECKS.nonEmpty).toBe(nonEmpty);
    expect(BUILTIN_CHECKS.maxLength).toBe(maxLength);
    expect(BUILTIN_CHECKS.validJson).toBe(validJson);
    expect(BUILTIN_CHECKS.matchesPattern).toBe(matchesPattern);
  });
});
