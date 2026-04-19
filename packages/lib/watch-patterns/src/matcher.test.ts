import { describe, expect, test } from "bun:test";
import type { PatternMatch, TaskItemId } from "@koi/core";
import { compilePatterns } from "./compile.js";
import { createLineBufferedMatcher } from "./matcher.js";

function buildMatcher(
  patterns: Array<{ pattern: string; event: string }>,
  onMatch: (m: PatternMatch) => void,
) {
  const c = compilePatterns(patterns);
  if (!c.ok) throw new Error(c.error.message);
  return createLineBufferedMatcher(c.value, onMatch);
}

const TASK = "task_1" as unknown as TaskItemId;

describe("createLineBufferedMatcher", () => {
  test("matches a complete line on stdout", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "ready", event: "ready" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "server ready\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stream).toBe("stdout");
    expect(seen[0]?.event).toBe("ready");
    expect(seen[0]?.lineNumber).toBe(1);
  });

  test("holds partial lines across chunks", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "ready", event: "ready" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "server ");
    expect(seen).toHaveLength(0);
    m.writeStdout(TASK, "ready\n");
    expect(seen).toHaveLength(1);
  });

  test("stdout and stderr have independent line buffers", () => {
    const seen: PatternMatch[] = [];
    // Use anchored "^A$" so it matches only the literal "A" line on stderr,
    // not "a" inside "part B" on stdout (default "i" flag would match "a" in "part").
    const m = buildMatcher(
      [
        { pattern: "^A$", event: "a" },
        { pattern: "B", event: "b" },
      ],
      (x) => {
        seen.push(x);
      },
    );
    m.writeStdout(TASK, "part ");
    m.writeStderr(TASK, "A\n");
    m.writeStdout(TASK, "B\n");
    expect(seen).toHaveLength(2);
    const stdoutMatch = seen.find((s) => s.stream === "stdout");
    const stderrMatch = seen.find((s) => s.stream === "stderr");
    expect(stdoutMatch?.event).toBe("b");
    expect(stderrMatch?.event).toBe("a");
  });

  test("per-stream lineNumber increments independently", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "x", event: "e" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "x\nx\n");
    m.writeStderr(TASK, "x\n");
    const stdoutNums = seen.filter((s) => s.stream === "stdout").map((s) => s.lineNumber);
    const stderrNums = seen.filter((s) => s.stream === "stderr").map((s) => s.lineNumber);
    expect(stdoutNums).toEqual([1, 2]);
    expect(stderrNums).toEqual([1]);
  });

  test("flush() scans trailing partial line on natural end", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "ready", event: "ready" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "almost ready");
    expect(seen).toHaveLength(0);
    m.flush(TASK);
    expect(seen).toHaveLength(1);
  });

  test("cancel() ignores subsequent writes", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "ready", event: "ready" }], (x) => {
      seen.push(x);
    });
    m.cancel();
    m.writeStdout(TASK, "ready\n");
    expect(seen).toHaveLength(0);
  });

  test("pattern throwing isolates other patterns (consumer error)", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher(
      [
        { pattern: "good", event: "good" },
        { pattern: "bad", event: "bad" },
      ],
      (x) => {
        if (x.event === "bad") throw new Error("consumer throws");
        seen.push(x);
      },
    );
    m.writeStdout(TASK, "good and bad on one line\n");
    const goodSeen = seen.filter((s) => s.event === "good");
    expect(goodSeen).toHaveLength(1);
  });

  test("handles \\r\\n line endings (strips trailing CR)", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "^ready$", event: "ready" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "ready\r\n");
    expect(seen).toHaveLength(1);
  });
});

describe("createLineBufferedMatcher — long lines", () => {
  // NOTE: this test REPLACES the old "16 KB sliding window: match in last 8 KB is still detected"
  // test. Under the new design, once a line overflows we suppress ALL further matches on that
  // logical line (announced via __watch_overflow__). The old test asserted incorrect behaviour.
  test("16 KB overflow: match BEFORE the trim fires once; match AFTER the trim is suppressed until next newline", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "NEEDLE", event: "needle" }], (x) => {
      seen.push(x);
    });

    // Emit 32 KB of filler — triggers overflow + suppression.
    m.writeStdout(TASK, " ".repeat(32 * 1024));
    // Emit "NEEDLE" after the trim — should NOT fire because we're in overflow mode.
    m.writeStdout(TASK, "NEEDLE");
    const duringOverflow = seen.filter((s) => s.event === "needle");
    expect(duringOverflow).toHaveLength(0);

    // Newline ends the logical line and resets overflow mode.
    m.writeStdout(TASK, "\n");

    // Now a new line with NEEDLE should match.
    m.writeStdout(TASK, "NEEDLE\n");
    const afterReset = seen.filter((s) => s.event === "needle");
    expect(afterReset).toHaveLength(1);
  });

  test("first trim emits __watch_overflow__ exactly once per logical line", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "x", event: "x" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "y".repeat(32 * 1024));
    m.writeStdout(TASK, "y".repeat(32 * 1024));
    const overflows = seen.filter((s) => s.event === "__watch_overflow__");
    expect(overflows).toHaveLength(1);
  });

  test("overflow emitted independently per stream", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "x", event: "x" }], (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "y".repeat(32 * 1024));
    m.writeStderr(TASK, "y".repeat(32 * 1024));
    const stdoutOverflows = seen.filter(
      (s) => s.event === "__watch_overflow__" && s.stream === "stdout",
    );
    const stderrOverflows = seen.filter(
      (s) => s.event === "__watch_overflow__" && s.stream === "stderr",
    );
    expect(stdoutOverflows).toHaveLength(1);
    expect(stderrOverflows).toHaveLength(1);
  });

  test("oversized newline-free line does not double-count the same match", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "marker", event: "m" }], (x) => {
      seen.push(x);
    });

    // Write "marker" early, then a lot of filler, then a final newline.
    // With the old bug, the marker would match ONCE when the buffer trimmed and AGAIN on the final newline.
    // Under the new design: the entire oversized partial is dropped on overflow, so NO match fires
    // for that logical line (it was announced lost via __watch_overflow__). Zero matches — not two.
    m.writeStdout(TASK, "marker ");
    m.writeStdout(TASK, " ".repeat(32 * 1024));
    m.writeStdout(TASK, "\n");

    const matches = seen.filter((s) => s.event === "m");
    expect(matches).toHaveLength(0); // dropped by overflow — not double-counted
  });

  test("overflow emits __watch_overflow__ once; lineNumber does NOT advance on trim", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "x", event: "x" }], (x) => {
      seen.push(x);
    });

    // First write normal line.
    m.writeStdout(TASK, "x\n");
    // Then trigger overflow.
    m.writeStdout(TASK, " ".repeat(32 * 1024));
    m.writeStdout(TASK, "\n");
    // Then another normal line.
    m.writeStdout(TASK, "x\n");

    const overflows = seen.filter((s) => s.event === "__watch_overflow__");
    expect(overflows).toHaveLength(1);

    const xMatches = seen.filter((s) => s.event === "x");
    expect(xMatches).toHaveLength(2);
    // lineNumbers: first regular "x" was line 1. The trim did NOT advance lineNumber.
    // The newline after overflow resets overflowMode but does NOT count as a line
    // (suppressed). The final "x" is line 2.
    expect(xMatches[0]?.lineNumber).toBe(1);
    expect(xMatches[1]?.lineNumber).toBe(2);
  });
});

describe("createLineBufferedMatcher — onMatchWithLine callback", () => {
  test("onMatchWithLine receives raw line + span when provided", () => {
    const seen: Array<{ line: string; start: number; end: number; event: string }> = [];
    const c = compilePatterns([{ pattern: "ready", event: "ready" }]);
    if (!c.ok) throw new Error(c.error.message);
    const m = createLineBufferedMatcher(
      c.value,
      () => {},
      (match, line, start, end) => {
        seen.push({ line, start, end, event: match.event });
      },
    );
    m.writeStdout(TASK, "server is ready now\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.line).toBe("server is ready now");
    const entry = seen[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("entry must be defined");
    expect(entry.line.slice(entry.start, entry.end)).toBe("ready");
    expect(entry.event).toBe("ready");
  });

  test("onMatchWithLine is not called when no match occurs", () => {
    const seen: Array<{ line: string }> = [];
    const c = compilePatterns([{ pattern: "ready", event: "ready" }]);
    if (!c.ok) throw new Error(c.error.message);
    const m = createLineBufferedMatcher(
      c.value,
      () => {},
      (_match, line) => {
        seen.push({ line });
      },
    );
    m.writeStdout(TASK, "no match on this line\n");
    expect(seen).toHaveLength(0);
  });

  test("existing callers without onMatchWithLine still work (backward compat)", () => {
    const seen: string[] = [];
    const c = compilePatterns([{ pattern: "ready", event: "ready" }]);
    if (!c.ok) throw new Error(c.error.message);
    const m = createLineBufferedMatcher(c.value, (match) => {
      seen.push(match.event);
    });
    m.writeStdout(TASK, "server ready\n");
    expect(seen).toEqual(["ready"]);
  });
});

describe("createLineBufferedMatcher — scanner-error isolation", () => {
  test("one pattern's scanner throwing does not block other patterns on the same line", () => {
    // Construct CompiledPattern directly — bypass compilePatterns so we can use a mock regex that throws.
    // This mirrors the matcher's internal contract and exercises the scanner-error catch path.
    const throwingRegex = {
      test: (): boolean => {
        throw new Error("regex engine bug");
      },
    };
    const workingRegex = { test: (line: string): boolean => line.includes("good") };
    const compiled = [
      { event: "broken", re: throwingRegex },
      { event: "good", re: workingRegex },
    ];

    const seen: PatternMatch[] = [];
    const m = createLineBufferedMatcher(compiled, (x) => {
      seen.push(x);
    });
    m.writeStdout(TASK, "the good line\n");
    const goodMatch = seen.find((s) => s.event === "good");
    expect(goodMatch).toBeDefined();
    const brokenMatch = seen.find((s) => s.event === "broken");
    expect(brokenMatch).toBeUndefined();
  });
});
