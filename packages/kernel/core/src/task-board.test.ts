import { describe, expect, test } from "bun:test";
import {
  isTerminalTaskStatus,
  isValidTransition,
  type TaskStatus,
  VALID_TASK_TRANSITIONS,
} from "./task-board.js";

const ALL_STATUSES: TaskStatus[] = ["pending", "in_progress", "completed", "failed", "killed"];

const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "killed"];
const NON_TERMINAL_STATUSES: TaskStatus[] = ["pending", "in_progress"];

describe("isTerminalTaskStatus", () => {
  test.each(TERMINAL_STATUSES)("returns true for terminal status '%s'", (status) => {
    expect(isTerminalTaskStatus(status)).toBe(true);
  });

  test.each(NON_TERMINAL_STATUSES)("returns false for non-terminal status '%s'", (status) => {
    expect(isTerminalTaskStatus(status)).toBe(false);
  });
});

describe("VALID_TASK_TRANSITIONS", () => {
  test("has an entry for every TaskStatus value", () => {
    for (const status of ALL_STATUSES) {
      expect(VALID_TASK_TRANSITIONS[status]).toBeDefined();
    }
  });

  test("terminal states have empty transition sets", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(VALID_TASK_TRANSITIONS[status].size).toBe(0);
    }
  });

  test("non-terminal states have non-empty transition sets", () => {
    for (const status of NON_TERMINAL_STATUSES) {
      expect(VALID_TASK_TRANSITIONS[status].size).toBeGreaterThan(0);
    }
  });

  test("no state can transition to itself", () => {
    for (const status of ALL_STATUSES) {
      expect(VALID_TASK_TRANSITIONS[status].has(status)).toBe(false);
    }
  });

  test("pending can transition to in_progress and killed only", () => {
    const targets = VALID_TASK_TRANSITIONS.pending;
    expect(targets.size).toBe(2);
    expect(targets.has("in_progress")).toBe(true);
    expect(targets.has("killed")).toBe(true);
  });

  test("in_progress can transition to completed, failed, and killed only", () => {
    const targets = VALID_TASK_TRANSITIONS.in_progress;
    expect(targets.size).toBe(3);
    expect(targets.has("completed")).toBe(true);
    expect(targets.has("failed")).toBe(true);
    expect(targets.has("killed")).toBe(true);
  });
});

describe("isValidTransition", () => {
  // Exhaustive 5×5 transition matrix
  const expectedValid: ReadonlySet<string> = new Set([
    "pending→in_progress",
    "pending→killed",
    "in_progress→completed",
    "in_progress→failed",
    "in_progress→killed",
  ]);

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const key = `${from}→${to}`;
      const shouldBeValid = expectedValid.has(key);
      test(`${key} is ${shouldBeValid ? "valid" : "invalid"}`, () => {
        expect(isValidTransition(from, to)).toBe(shouldBeValid);
      });
    }
  }
});
