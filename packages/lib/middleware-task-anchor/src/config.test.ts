import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HEADER,
  DEFAULT_IDLE_TURN_THRESHOLD,
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
