import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { taskId } from "@koi/core";
import { createCancelSleepTool } from "./cancel-sleep-tool.js";
import { createSchedulerStub } from "./test-helpers.js";

function exec(
  tool: { readonly execute: (args: JsonObject) => Promise<unknown> },
  args: JsonObject,
): Promise<unknown> {
  return tool.execute(args);
}

describe("cancel_sleep tool", () => {
  test("forwards task id and returns scheduler removed flag", async () => {
    const stub = createSchedulerStub();
    const tool = createCancelSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { task_id: "task-7" })) as {
      ok: boolean;
      removed: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(stub.cancelCalls).toEqual([taskId("task-7")]);
  });

  test("returns removed:false when scheduler reports the task already fired", async () => {
    const stub = createSchedulerStub({ cancelResult: false });
    const tool = createCancelSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { task_id: "task-fired" })) as {
      ok: boolean;
      removed: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("rejects empty task_id without calling scheduler", async () => {
    const stub = createSchedulerStub();
    const tool = createCancelSleepTool({ scheduler: stub.component });

    const result = (await exec(tool, { task_id: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(stub.cancelCalls).toHaveLength(0);
  });
});
