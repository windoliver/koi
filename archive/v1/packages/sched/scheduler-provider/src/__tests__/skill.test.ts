import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent, TaskScheduler } from "@koi/core";
import { isAttachResult, scheduleId, skillToken, taskId } from "@koi/core";

import { createSchedulerProvider } from "../scheduler-component-provider.js";
import { createMockAgent } from "../test-helpers.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

/** Stub TaskScheduler that satisfies the full interface. */
function createMockTaskScheduler(): TaskScheduler {
  return {
    submit: () => taskId("task-1"),
    cancel: () => true,
    schedule: () => scheduleId("sched-1"),
    unschedule: () => true,
    pause: () => true,
    resume: () => true,
    query: () => [],
    stats: () => ({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      deadLettered: 0,
      activeSchedules: 0,
      pausedSchedules: 0,
    }),
    history: () => [],
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createSchedulerProvider({
      scheduler: createMockTaskScheduler(),
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken("scheduler") as string);
    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("scheduler");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });
});
