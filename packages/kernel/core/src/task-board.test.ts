import { describe, expect, test } from "bun:test";
import {
  isTerminalTaskStatus,
  isValidTaskKindName,
  isValidTransition,
  TASK_KIND_NAMES,
  type TaskKindName,
  type TaskStatus,
  taskItemId,
  VALID_TASK_KIND_NAMES,
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

// ---------------------------------------------------------------------------
// taskItemId — branded constructor
// ---------------------------------------------------------------------------

describe("taskItemId", () => {
  test("returns the same string value", () => {
    expect(taskItemId("abc") as string).toBe("abc");
  });

  test("round-trips through string coercion", () => {
    const id = taskItemId("task_42");
    expect(String(id)).toBe("task_42");
  });
});

// ---------------------------------------------------------------------------
// TaskKindName — runtime validation
// ---------------------------------------------------------------------------

const ALL_KIND_NAMES: TaskKindName[] = [
  "local_shell",
  "local_agent",
  "remote_agent",
  "in_process_teammate",
  "dream",
];

describe("TASK_KIND_NAMES / VALID_TASK_KIND_NAMES", () => {
  test("TASK_KIND_NAMES tuple and VALID_TASK_KIND_NAMES set are mechanically in sync", () => {
    expect(VALID_TASK_KIND_NAMES.size).toBe(TASK_KIND_NAMES.length);
    for (const kind of TASK_KIND_NAMES) {
      expect(VALID_TASK_KIND_NAMES.has(kind)).toBe(true);
    }
  });

  test("contains exactly the 5 defined kind names", () => {
    expect(VALID_TASK_KIND_NAMES.size).toBe(5);
    for (const kind of ALL_KIND_NAMES) {
      expect(VALID_TASK_KIND_NAMES.has(kind)).toBe(true);
    }
  });

  test("TASK_KIND_NAMES is frozen (immutable at runtime)", () => {
    expect(Object.isFrozen(TASK_KIND_NAMES)).toBe(true);
  });

  test("VALID_TASK_KIND_NAMES has ReadonlySet API (.has method)", () => {
    expect(typeof VALID_TASK_KIND_NAMES.has).toBe("function");
    expect(VALID_TASK_KIND_NAMES.has("local_shell")).toBe(true);
    expect(VALID_TASK_KIND_NAMES.has("bogus")).toBe(false);
  });
});

describe("isValidTaskKindName", () => {
  test.each(ALL_KIND_NAMES)("returns true for valid kind '%s'", (kind) => {
    expect(isValidTaskKindName(kind)).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(isValidTaskKindName("")).toBe(false);
  });

  test("returns false for arbitrary string", () => {
    expect(isValidTaskKindName("bogus_kind")).toBe(false);
  });

  test("returns false for close misspelling", () => {
    expect(isValidTaskKindName("local_shel")).toBe(false);
    expect(isValidTaskKindName("localshell")).toBe(false);
    expect(isValidTaskKindName("LOCAL_SHELL")).toBe(false);
  });

  test("returns false for partial match", () => {
    expect(isValidTaskKindName("local")).toBe(false);
    expect(isValidTaskKindName("dream_task")).toBe(false);
  });
});
