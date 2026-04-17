import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HEADER,
  DEFAULT_IDLE_TURN_THRESHOLD,
  defaultIsMutatingTaskTool,
  defaultIsTaskTool,
  validateTaskAnchorConfig,
} from "./config.js";

describe("validateTaskAnchorConfig", () => {
  const getBoard = (): undefined => undefined;

  test("accepts minimal valid config", () => {
    const result = validateTaskAnchorConfig({ getBoard });
    expect(result.ok).toBe(true);
  });

  test("rejects null / non-object input", () => {
    expect(validateTaskAnchorConfig(null).ok).toBe(false);
    expect(validateTaskAnchorConfig(undefined).ok).toBe(false);
    expect(validateTaskAnchorConfig(42).ok).toBe(false);
    expect(validateTaskAnchorConfig("x").ok).toBe(false);
  });

  test("rejects missing getBoard", () => {
    const result = validateTaskAnchorConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("getBoard");
    }
  });

  test("rejects non-positive idleTurnThreshold", () => {
    expect(validateTaskAnchorConfig({ getBoard, idleTurnThreshold: 0 }).ok).toBe(false);
    expect(validateTaskAnchorConfig({ getBoard, idleTurnThreshold: -1 }).ok).toBe(false);
    expect(validateTaskAnchorConfig({ getBoard, idleTurnThreshold: 1.5 }).ok).toBe(false);
    expect(validateTaskAnchorConfig({ getBoard, idleTurnThreshold: "3" }).ok).toBe(false);
  });

  test("accepts positive integer idleTurnThreshold", () => {
    expect(validateTaskAnchorConfig({ getBoard, idleTurnThreshold: 1 }).ok).toBe(true);
    expect(validateTaskAnchorConfig({ getBoard, idleTurnThreshold: 10 }).ok).toBe(true);
  });

  test("rejects non-function isTaskTool", () => {
    expect(validateTaskAnchorConfig({ getBoard, isTaskTool: "task_" }).ok).toBe(false);
  });

  test("accepts isTaskTool override without isMutatingTaskTool (backward-compat)", () => {
    // Preserves existing callers: custom `isTaskTool` is valid alone; the
    // default mutating predicate still applies. Callers with custom mutating
    // tools should also pass `isMutatingTaskTool` for tight rollback coverage.
    const result = validateTaskAnchorConfig({
      getBoard,
      isTaskTool: (id: string) => id.startsWith("custom_"),
    });
    expect(result.ok).toBe(true);
  });

  test("accepts custom isTaskTool + isMutatingTaskTool together", () => {
    const result = validateTaskAnchorConfig({
      getBoard,
      isTaskTool: (id: string) => id.startsWith("custom_"),
      isMutatingTaskTool: (id: string) => id === "custom_mutate",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-boolean nudgeOnEmptyBoard", () => {
    expect(validateTaskAnchorConfig({ getBoard, nudgeOnEmptyBoard: "yes" }).ok).toBe(false);
  });

  test("rejects empty-string header", () => {
    expect(validateTaskAnchorConfig({ getBoard, header: "" }).ok).toBe(false);
  });

  test("defaults are exposed", () => {
    expect(DEFAULT_IDLE_TURN_THRESHOLD).toBe(3);
    expect(DEFAULT_HEADER).toBe("Current tasks");
  });
});

describe("defaultIsTaskTool", () => {
  test("matches task_* ids", () => {
    expect(defaultIsTaskTool("task_create")).toBe(true);
    expect(defaultIsTaskTool("task_update")).toBe(true);
    expect(defaultIsTaskTool("task_list")).toBe(true);
  });

  test("does not match unrelated ids", () => {
    expect(defaultIsTaskTool("bash")).toBe(false);
    expect(defaultIsTaskTool("write")).toBe(false);
    expect(defaultIsTaskTool("taskboard")).toBe(false);
  });
});

describe("defaultIsMutatingTaskTool — matches real @koi/task-tools mutating surface", () => {
  // Real task tools exported by @koi/task-tools (as of this branch):
  // mutating: task_create, task_update, task_delegate, task_stop
  // read-only: task_get, task_list, task_output
  test("accepts every actual mutating task tool", () => {
    expect(defaultIsMutatingTaskTool("task_create")).toBe(true);
    expect(defaultIsMutatingTaskTool("task_update")).toBe(true);
    expect(defaultIsMutatingTaskTool("task_delegate")).toBe(true);
    expect(defaultIsMutatingTaskTool("task_stop")).toBe(true);
  });

  test("rejects every actual read-only task tool", () => {
    expect(defaultIsMutatingTaskTool("task_get")).toBe(false);
    expect(defaultIsMutatingTaskTool("task_list")).toBe(false);
    expect(defaultIsMutatingTaskTool("task_output")).toBe(false);
  });

  test("rejects non-existent task_* names to prevent drift false-positives", () => {
    expect(defaultIsMutatingTaskTool("task_delete")).toBe(false);
    expect(defaultIsMutatingTaskTool("task_kill")).toBe(false);
    expect(defaultIsMutatingTaskTool("task_complete")).toBe(false);
    expect(defaultIsMutatingTaskTool("task_fail")).toBe(false);
  });
});
