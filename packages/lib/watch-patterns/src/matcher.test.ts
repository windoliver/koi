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
  test("16 KB sliding window: match in last 8 KB is still detected", () => {
    const seen: PatternMatch[] = [];
    const m = buildMatcher([{ pattern: "NEEDLE", event: "needle" }], (x) => {
      seen.push(x);
    });
    const filler = " ".repeat(32 * 1024);
    m.writeStdout(TASK, filler);
    m.writeStdout(TASK, "NEEDLE\n");
    const needle = seen.find((s) => s.event === "needle");
    expect(needle).toBeDefined();
  });

  test("first trim emits __watch_overflow__ exactly once per task", () => {
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
