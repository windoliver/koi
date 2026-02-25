import { describe, expect, it } from "bun:test";
import {
  isTaskSpawnFailure,
  isTaskSpawnSuccess,
  TASK_TOOL_DESCRIPTOR,
  type TaskSpawnResult,
} from "./types.js";

describe("isTaskSpawnSuccess", () => {
  it("returns true for ok result", () => {
    const result: TaskSpawnResult = { ok: true, output: "done" };
    expect(isTaskSpawnSuccess(result)).toBe(true);
  });

  it("returns false for error result", () => {
    const result: TaskSpawnResult = { ok: false, error: "failed" };
    expect(isTaskSpawnSuccess(result)).toBe(false);
  });
});

describe("isTaskSpawnFailure", () => {
  it("returns true for error result", () => {
    const result: TaskSpawnResult = { ok: false, error: "failed" };
    expect(isTaskSpawnFailure(result)).toBe(true);
  });

  it("returns false for ok result", () => {
    const result: TaskSpawnResult = { ok: true, output: "done" };
    expect(isTaskSpawnFailure(result)).toBe(false);
  });
});

describe("TASK_TOOL_DESCRIPTOR", () => {
  it("has name 'task'", () => {
    expect(TASK_TOOL_DESCRIPTOR.name).toBe("task");
  });

  it("requires description in input schema", () => {
    const schema = TASK_TOOL_DESCRIPTOR.inputSchema;
    expect(schema.required).toEqual(["description"]);
  });

  it("defines description and agent_type properties", () => {
    const props = TASK_TOOL_DESCRIPTOR.inputSchema.properties as Record<string, unknown>;
    expect(props.description).toBeDefined();
    expect(props.agent_type).toBeDefined();
  });
});
