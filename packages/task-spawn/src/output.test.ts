import { describe, expect, it } from "bun:test";
import { extractOutput } from "./output.js";
import type { TaskSpawnResult } from "./types.js";

describe("extractOutput", () => {
  it("returns output text on success", () => {
    const result: TaskSpawnResult = { ok: true, output: "Hello world" };
    expect(extractOutput(result)).toBe("Hello world");
  });

  it("returns default message for empty success output", () => {
    const result: TaskSpawnResult = { ok: true, output: "" };
    expect(extractOutput(result)).toBe("(task completed with no output)");
  });

  it("returns failure message on error", () => {
    const result: TaskSpawnResult = { ok: false, error: "connection lost" };
    expect(extractOutput(result)).toBe("Task failed: connection lost");
  });

  it("preserves multiline output", () => {
    const result: TaskSpawnResult = { ok: true, output: "line1\nline2\nline3" };
    expect(extractOutput(result)).toBe("line1\nline2\nline3");
  });

  it("preserves empty-looking error messages", () => {
    const result: TaskSpawnResult = { ok: false, error: "" };
    expect(extractOutput(result)).toBe("Task failed: ");
  });
});
