import { expect, test } from "bun:test";
import type { TeamEvent } from "./events.js";

test("task.completed carries output payload", () => {
  const event: TeamEvent = {
    kind: "task.completed",
    eventId: "e1",
    teamRunId: "run_1",
    timestamp: 1,
    taskId: "task_a",
    agentId: "coder-1",
    payload: { output: "done" },
  };

  expect(event.payload.output).toBe("done");
});
