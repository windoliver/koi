import { describe, expect, test } from "bun:test";

import type { Task, TaskBoard, TaskItemId } from "@koi/core";

import { buildEmptyBoardNudge, buildTaskReminder, formatTaskList } from "./reminder-format.js";

function makeTask(partial: Partial<Task> & Pick<Task, "id" | "status" | "subject">): Task {
  return {
    description: partial.subject,
    dependencies: [],
    retries: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function makeBoard(tasks: readonly Task[]): TaskBoard {
  const unimplemented = (): never => {
    throw new Error("not implemented in test fixture");
  };
  return {
    add: unimplemented,
    addAll: unimplemented,
    assign: unimplemented,
    unassign: unimplemented,
    complete: unimplemented,
    fail: unimplemented,
    kill: unimplemented,
    update: unimplemented,
    result: () => undefined,
    get: (id) => tasks.find((t) => t.id === id),
    ready: () => tasks.filter((t) => t.status === "pending"),
    pending: () => tasks.filter((t) => t.status === "pending"),
    blocked: () => [],
    inProgress: () => tasks.filter((t) => t.status === "in_progress"),
    completed: () => [],
    failed: () => tasks.filter((t) => t.status === "failed"),
    killed: () => tasks.filter((t) => t.status === "killed"),
    unreachable: () => [],
    dependentsOf: () => [],
    blockedBy: () => undefined,
    all: () => tasks,
    size: () => tasks.length,
  };
}

const id = (v: string): TaskItemId => v as TaskItemId;

describe("formatTaskList", () => {
  test("formats multiple tasks with status markers", () => {
    const board = makeBoard([
      makeTask({ id: id("t1"), subject: "Audit auth code", status: "completed" }),
      makeTask({ id: id("t2"), subject: "Design new session model", status: "in_progress" }),
      makeTask({ id: id("t3"), subject: "Migrate sessions", status: "pending" }),
    ]);
    const out = formatTaskList(board);
    expect(out).toBe(
      [
        "- [x] Audit auth code",
        "- [in_progress] Design new session model",
        "- [ ] Migrate sessions",
      ].join("\n"),
    );
  });

  test("returns empty string when board is empty", () => {
    expect(formatTaskList(makeBoard([]))).toBe("");
  });

  test("falls back to description when subject is empty", () => {
    const board = makeBoard([
      {
        id: id("t1"),
        subject: "",
        description: "Fallback desc",
        dependencies: [],
        status: "pending",
        retries: 0,
        version: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(formatTaskList(board)).toBe("- [ ] Fallback desc");
  });

  test("renders failed and killed status", () => {
    const board = makeBoard([
      makeTask({ id: id("t1"), subject: "Broken step", status: "failed" }),
      makeTask({ id: id("t2"), subject: "Cancelled step", status: "killed" }),
    ]);
    expect(formatTaskList(board)).toContain("[failed]");
    expect(formatTaskList(board)).toContain("[killed]");
  });
});

describe("buildTaskReminder", () => {
  test("wraps body in system-reminder tags with header and anti-leak line", () => {
    const block = buildTaskReminder("Current tasks", "- [ ] Do a thing");
    expect(block.startsWith("<system-reminder>")).toBe(true);
    expect(block.endsWith("</system-reminder>")).toBe(true);
    expect(block).toContain("Current tasks:");
    expect(block).toContain("- [ ] Do a thing");
    expect(block).toContain("Don't mention this reminder to the user.");
  });
});

describe("buildEmptyBoardNudge", () => {
  test("suggests task_create inside a system-reminder block", () => {
    const block = buildEmptyBoardNudge();
    expect(block).toContain("<system-reminder>");
    expect(block).toContain("task_create");
    expect(block).toContain("Don't mention this reminder to the user.");
  });
});
