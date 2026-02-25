import { describe, expect, it } from "bun:test";
import { formatBatchResult } from "./output.js";
import type { BatchResult, MinionTask } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTasks(descriptions: readonly string[]): readonly MinionTask[] {
  return descriptions.map((d) => ({ description: d }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatBatchResult", () => {
  it("formats all-success results", () => {
    const result: BatchResult = {
      outcomes: [
        { ok: true, taskIndex: 0, output: "Answer A" },
        { ok: true, taskIndex: 1, output: "Answer B" },
      ],
      summary: { total: 2, succeeded: 2, failed: 0, strategy: "best-effort" },
    };
    const tasks = makeTasks(["Research A", "Research B"]);

    const output = formatBatchResult(result, tasks);

    expect(output).toContain("2/2 succeeded");
    expect(output).toContain("strategy: best-effort");
    expect(output).toContain("### Task 1: Research A [SUCCESS]");
    expect(output).toContain("Answer A");
    expect(output).toContain("### Task 2: Research B [SUCCESS]");
    expect(output).toContain("Answer B");
  });

  it("formats mixed success/failure", () => {
    const result: BatchResult = {
      outcomes: [
        { ok: true, taskIndex: 0, output: "Good result" },
        { ok: false, taskIndex: 1, error: "Something went wrong" },
      ],
      summary: { total: 2, succeeded: 1, failed: 1, strategy: "fail-fast" },
    };
    const tasks = makeTasks(["Good task", "Bad task"]);

    const output = formatBatchResult(result, tasks);

    expect(output).toContain("1/2 succeeded");
    expect(output).toContain("strategy: fail-fast");
    expect(output).toContain("[SUCCESS]");
    expect(output).toContain("[FAILED]");
    expect(output).toContain("Error: Something went wrong");
  });

  it("formats empty results", () => {
    const result: BatchResult = {
      outcomes: [],
      summary: { total: 0, succeeded: 0, failed: 0, strategy: "best-effort" },
    };

    const output = formatBatchResult(result, []);

    expect(output).toContain("0/0 succeeded");
    expect(output).not.toContain("### Task");
  });

  it("truncates total output when exceeding maxTotalOutput", () => {
    const longOutput = "x".repeat(1_000);
    const result: BatchResult = {
      outcomes: Array.from({ length: 10 }, (_, i) => ({
        ok: true as const,
        taskIndex: i,
        output: longOutput,
      })),
      summary: { total: 10, succeeded: 10, failed: 0, strategy: "best-effort" },
    };
    const tasks = makeTasks(Array.from({ length: 10 }, (_, i) => `Task ${i}`));

    const output = formatBatchResult(result, tasks, 3_000);

    expect(output).toContain("10/10 succeeded");
    expect(output).toContain("[remaining output truncated");
    expect(output.length).toBeLessThanOrEqual(3_000);
  });

  it("orders outcomes by taskIndex", () => {
    const result: BatchResult = {
      outcomes: [
        { ok: true, taskIndex: 2, output: "C" },
        { ok: true, taskIndex: 0, output: "A" },
        { ok: true, taskIndex: 1, output: "B" },
      ],
      summary: { total: 3, succeeded: 3, failed: 0, strategy: "best-effort" },
    };
    const tasks = makeTasks(["First", "Second", "Third"]);

    const output = formatBatchResult(result, tasks);

    const pos1 = output.indexOf("Task 1:");
    const pos2 = output.indexOf("Task 2:");
    const pos3 = output.indexOf("Task 3:");
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });

  it("includes quorum strategy in output", () => {
    const result: BatchResult = {
      outcomes: [{ ok: true, taskIndex: 0, output: "ok" }],
      summary: { total: 1, succeeded: 1, failed: 0, strategy: "quorum" },
    };
    const tasks = makeTasks(["task"]);

    const output = formatBatchResult(result, tasks);
    expect(output).toContain("strategy: quorum");
  });
});
