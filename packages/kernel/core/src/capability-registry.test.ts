import { describe, expect, test } from "bun:test";
import { isToolCallPayload } from "./capability-registry.js";

describe("isToolCallPayload", () => {
  test("accepts valid payload shape", () => {
    expect(
      isToolCallPayload({
        toolName: "read_file",
        args: { path: "README.md" },
        callerAgentId: "agent-1",
      }),
    ).toBe(true);
  });

  test("rejects payload missing args", () => {
    expect(
      isToolCallPayload({
        toolName: "read_file",
        callerAgentId: "agent-1",
      }),
    ).toBe(false);
  });

  test("rejects payload with non-object args", () => {
    expect(
      isToolCallPayload({
        toolName: "read_file",
        args: "path=README.md",
        callerAgentId: "agent-1",
      }),
    ).toBe(false);
  });
});
