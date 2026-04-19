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
