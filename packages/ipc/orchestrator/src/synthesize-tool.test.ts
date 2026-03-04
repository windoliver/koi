import { describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import { executeSynthesize } from "./synthesize-tool.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

function createHolder(board?: TaskBoard): BoardHolder {
  // let justified: mutable board reference
  let b: TaskBoard = board ?? createTaskBoard();
  return {
    getBoard: () => b,
    setBoard: (nb: TaskBoard) => {
      b = nb;
    },
  };
}

describe("executeSynthesize", () => {
  test("returns message when no completed tasks", () => {
    const holder = createHolder();
    const result = executeSynthesize({}, holder);
    expect(result).toContain("No completed tasks");
  });

  test("aggregates multiple results in dependency order", () => {
    const board = createTaskBoard();
    const r1 = board.addAll([
      { id: taskItemId("a"), description: "First" },
      { id: taskItemId("b"), description: "Second", dependencies: [taskItemId("a")] },
    ]);
    if (!r1.ok) throw new Error("setup failed");

    // Complete a then b
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "output-a",
      durationMs: 100,
    });
    if (!r3.ok) throw new Error("setup failed");
    const r4 = r3.value.assign(taskItemId("b"), agentId("w2"));
    if (!r4.ok) throw new Error("setup failed");
    const r5 = r4.value.complete(taskItemId("b"), {
      taskId: taskItemId("b"),
      output: "output-b",
      durationMs: 100,
    });
    if (!r5.ok) throw new Error("setup failed");

    const holder = createHolder(r5.value);
    const result = executeSynthesize({}, holder);
    expect(result).toContain("2 task(s)");
    // a should appear before b (topological order)
    const aIdx = result.indexOf("output-a");
    const bIdx = result.indexOf("output-b");
    expect(aIdx).toBeLessThan(bIdx);
  });

  test("truncates long outputs at maxOutputPerTask", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "Long output" });
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const longOutput = "x".repeat(200);
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: longOutput,
      durationMs: 100,
    });
    if (!r3.ok) throw new Error("setup failed");

    const holder = createHolder(r3.value);
    const result = executeSynthesize({}, holder, 50);
    expect(result).toContain("truncated");
  });

  test("renders artifacts section when present", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "With artifacts" });
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "done",
      durationMs: 100,
      artifacts: [
        { id: "art-1", kind: "file", uri: "file:///report.json" },
        { id: "art-2", kind: "data", uri: "data:text/plain,hello" },
      ],
    });
    if (!r3.ok) throw new Error("setup failed");

    const holder = createHolder(r3.value);
    const result = executeSynthesize({}, holder);
    expect(result).toContain("### Artifacts");
    expect(result).toContain("file: file:///report.json");
    expect(result).toContain("data: data:text/plain,hello");
  });

  test("renders warnings section when present", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "With warnings" });
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "done",
      durationMs: 100,
      warnings: ["disk almost full", "slow network"],
    });
    if (!r3.ok) throw new Error("setup failed");

    const holder = createHolder(r3.value);
    const result = executeSynthesize({}, holder);
    expect(result).toContain("### Warnings");
    expect(result).toContain("disk almost full");
    expect(result).toContain("slow network");
  });

  test("renders decisions section when present", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "With decisions" });
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "done",
      durationMs: 100,
      decisions: [
        { agentId: agentId("w1"), action: "chose X", reasoning: "best option", timestamp: 1 },
      ],
    });
    if (!r3.ok) throw new Error("setup failed");

    const holder = createHolder(r3.value);
    const result = executeSynthesize({}, holder);
    expect(result).toContain("### Decisions");
    expect(result).toContain("chose X");
    expect(result).toContain("best option");
  });

  test("omits structured sections when fields are empty or undefined", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "Plain" });
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "just output",
      durationMs: 100,
    });
    if (!r3.ok) throw new Error("setup failed");

    const holder = createHolder(r3.value);
    const result = executeSynthesize({}, holder);
    expect(result).not.toContain("### Artifacts");
    expect(result).not.toContain("### Warnings");
    expect(result).not.toContain("### Decisions");
  });
});
