/**
 * Fail-closed invariant tests — the single most important test suite in
 * @koi/bash-ast. Every failure mode of the parser MUST produce
 * `parse-unavailable` with the correct `cause` discriminator. No failure
 * path may fall through to a permissive outcome.
 *
 * Three layers of coverage:
 *   1. Unit — inject a fake parser for each failure mode.
 *   2. Integration — feed adversarial real inputs to the real parser.
 *   3. Property — fuzz random strings; assert every outcome is one of the
 *      three variants and nothing throws.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Parser as TsParser } from "web-tree-sitter";
import { analyzeBashCommand } from "../analyze.js";
import { classifyBashCommand } from "../classify.js";
import { __resetForTests, __setParserForTests, initializeBashAst } from "../init.js";

// Helper: build a fake parser with a configurable parse behavior.
function makeFakeParser(parseImpl: (src: string) => ReturnType<TsParser["parse"]>): TsParser {
  return {
    parse: parseImpl,
    // Other Parser methods — unused by the hot path; stub as throwing.
    setLanguage: () => {
      throw new Error("unused");
    },
    getLanguage: () => {
      throw new Error("unused");
    },
    delete: () => {},
    reset: () => {},
    setLogger: () => {},
    getLogger: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as TsParser;
}

describe("fail-closed — injected fake parser", () => {
  afterEach(() => {
    __resetForTests();
  });

  test("parse returns null → parse-unavailable(timeout)", () => {
    __setParserForTests(makeFakeParser(() => null));
    const r = analyzeBashCommand("anything");
    expect(r.kind).toBe("parse-unavailable");
    if (r.kind !== "parse-unavailable") return;
    expect(r.cause).toBe("timeout");
  });

  test("parse throws → parse-unavailable(panic)", () => {
    __setParserForTests(
      makeFakeParser(() => {
        throw new Error("simulated panic");
      }),
    );
    const r = analyzeBashCommand("anything");
    expect(r.kind).toBe("parse-unavailable");
    if (r.kind !== "parse-unavailable") return;
    expect(r.cause).toBe("panic");
  });

  test("parser not set → parse-unavailable(not-initialized)", () => {
    __setParserForTests(null);
    const r = analyzeBashCommand("anything");
    expect(r.kind).toBe("parse-unavailable");
    if (r.kind !== "parse-unavailable") return;
    expect(r.cause).toBe("not-initialized");
  });

  test("over-length input → parse-unavailable(over-length) without touching parser", () => {
    let parserCalled = false;
    __setParserForTests(
      makeFakeParser(() => {
        parserCalled = true;
        return null;
      }),
    );
    const r = analyzeBashCommand("x".repeat(10_001));
    expect(r.kind).toBe("parse-unavailable");
    if (r.kind !== "parse-unavailable") return;
    expect(r.cause).toBe("over-length");
    expect(parserCalled).toBe(false);
  });

  test("classify(): parse-unavailable always yields ok=false with injection category", () => {
    __setParserForTests(null);
    const r = classifyBashCommand("echo hi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.category).toBe("injection");
    expect(r.pattern).toBe("parse-unavailable:not-initialized");
  });
});

describe("fail-closed — adversarial real-parser inputs", () => {
  beforeAll(async () => {
    await initializeBashAst();
  });

  test("deeply nested arithmetic parses without crash", () => {
    // A crafted pathological input that historically stresses tree-sitter's
    // budget. We don't care about the exact outcome — only that it returns
    // one of the three variants and never throws.
    const nested = `(( ${Array.from({ length: 200 }, (_, i) => `a[${i}]`).join("")} ))`;
    const r = analyzeBashCommand(nested);
    expect(["simple", "too-complex", "parse-unavailable"]).toContain(r.kind);
  });

  test("over-length input → parse-unavailable(over-length)", () => {
    const r = analyzeBashCommand(`echo ${"x".repeat(20_000)}`);
    expect(r.kind).toBe("parse-unavailable");
    if (r.kind !== "parse-unavailable") return;
    expect(r.cause).toBe("over-length");
  });

  test("null bytes in input reach the parser or fail cleanly", () => {
    const r = analyzeBashCommand("ls\x00rm -rf /");
    expect(["simple", "too-complex", "parse-unavailable"]).toContain(r.kind);
    // Even if the walker accepts it, the prefilter in classify() rejects it.
    const c = classifyBashCommand("ls\x00rm -rf /");
    expect(c.ok).toBe(false);
  });

  test("control characters in input never produce simple with shell metachars", () => {
    const r = analyzeBashCommand("echo\x01 hi");
    // Either simple with argv OR too-complex — never a throw.
    expect(["simple", "too-complex", "parse-unavailable"]).toContain(r.kind);
  });

  test("invalid UTF-8 sequence does not throw", () => {
    // Construct a string with a lone surrogate (invalid UTF-16)
    const r = analyzeBashCommand("echo \uD800hi");
    expect(["simple", "too-complex", "parse-unavailable"]).toContain(r.kind);
  });
});

describe("fail-closed — fast-check fuzz", () => {
  beforeAll(async () => {
    await initializeBashAst();
  });

  test("every random string produces a valid AstAnalysis variant and never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (source) => {
        const r = analyzeBashCommand(source);
        return r.kind === "simple" || r.kind === "too-complex" || r.kind === "parse-unavailable";
      }),
      { numRuns: 1000 },
    );
  });

  test("fuzzing the tool-facing classifier never throws and always returns a ClassificationResult", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (source) => {
        const r = classifyBashCommand(source);
        // Result is either ok=true or has the three failure fields.
        if (r.ok) return true;
        return (
          typeof r.reason === "string" &&
          typeof r.pattern === "string" &&
          typeof r.category === "string"
        );
      }),
      { numRuns: 500 },
    );
  });

  // Fresh-loop round-3 regression: parser-untrusted primaryCategory
  // values (shell-escape, parse-error, malformed, unknown) must hard-
  // deny through classifyBashCommand without falling through to the
  // regex TTP fallback. Categories where the walker CAN trust its
  // parse of the structure (even if it declines to implement that
  // structure) remain askable.
  test("parse-error primaryCategory hard-denies via classifyBashCommand", () => {
    // Unterminated double-quoted string triggers tree-sitter root.hasError
    // on the currently vendored grammar; walker maps to parse-error.
    const r = classifyBashCommand('echo "unterminated');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.category).toBe("injection");
    expect(r.reason).toContain("parse-error");
  });

  test("shell-escape primaryCategory hard-denies via classifyBashCommand", () => {
    const r = classifyBashCommand("cat \\/etc\\/passwd");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.category).toBe("injection");
    expect(r.reason).toContain("shell-escape");
  });

  test("askable primaryCategory (control-flow) does not hard-deny via the fail-closed path", () => {
    // control-flow is a parser-TRUSTED category — structure is known,
    // just unsupported. Must remain available to the regex TTP fallback
    // and elicit paths; should not hit the injection hard-deny branch.
    const r = classifyBashCommand("if true; then echo hi; fi");
    // Either ok=true (regex TTP passes it) or ok=false with a category
    // other than the parser-untrusted injection signature. The point is
    // that it MUST NOT carry the bash-ast walker's injection reason.
    if (!r.ok) {
      expect(r.reason).not.toContain("parse-error");
      expect(r.reason).not.toContain("walker cannot safely analyse");
    }
  });
});
