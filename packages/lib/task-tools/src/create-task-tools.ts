/**
 * createTaskTools — factory that returns all 6 task management tools.
 *
 * Includes a verification nudge: after 3+ task completions without a
 * verification task, task_update responses include a reminder to verify.
 * The counter is closure-scoped (O(1), resets on restart — appropriate
 * for advisory-only behavior per Decision 14A).
 */

import type { JsonObject, TaskItemId, Tool, ToolExecuteOptions } from "@koi/core";
import { createTaskCreateTool } from "./tools/task-create.js";
import { createTaskDelegateTool } from "./tools/task-delegate.js";
import { createTaskGetTool } from "./tools/task-get.js";
import { createTaskListTool } from "./tools/task-list.js";
import { createTaskOutputTool } from "./tools/task-output.js";
import { createTaskStopTool } from "./tools/task-stop.js";
import { createTaskUpdateTool } from "./tools/task-update.js";
import type { TaskToolsConfig } from "./types.js";

const VERIF_NUDGE_THRESHOLD = 3;
const VERIF_PATTERN = /verif/i;
const NUDGE_MESSAGE =
  "Reminder: consider adding a verification task to confirm your progress before continuing.";

export function createTaskTools(config: TaskToolsConfig): readonly Tool[] {
  const { board, agentId } = config;

  // let justified: mutable counter for the verification nudge (closure state, O(1))
  let consecutiveNonVerif = 0;

  function checkNudge(taskSubject: string): string | undefined {
    if (VERIF_PATTERN.test(taskSubject)) {
      consecutiveNonVerif = 0;
      return undefined;
    }
    consecutiveNonVerif += 1;
    return consecutiveNonVerif >= VERIF_NUDGE_THRESHOLD ? NUDGE_MESSAGE : undefined;
  }

  const innerUpdateTool = createTaskUpdateTool(board, agentId, (subject) => {
    // onComplete callback — nudge check happens in the wrapper below
    void subject;
  });

  // Wrap task_update to inject the verification nudge into completion responses
  const updateTool: Tool = {
    ...innerUpdateTool,
    execute: async (args: JsonObject, options?: ToolExecuteOptions) => {
      const result = await innerUpdateTool.execute(args, options);

      // Inject nudge only on successful completion transitions
      if (
        result !== null &&
        typeof result === "object" &&
        "ok" in result &&
        (result as { ok: unknown }).ok === true &&
        typeof args === "object" &&
        args !== null &&
        "status" in args &&
        (args as { status: unknown }).status === "completed"
      ) {
        const taskIdRaw = (args as { task_id?: unknown }).task_id;
        const taskId = typeof taskIdRaw === "string" ? taskIdRaw : "";
        const task = board.snapshot().get(taskId as TaskItemId);
        const nudge = checkNudge(task?.subject ?? taskId);
        if (nudge !== undefined) {
          return { ...(result as Record<string, unknown>), nudge };
        }
      }
      return result;
    },
  };

  return [
    createTaskCreateTool(board),
    createTaskGetTool(board),
    updateTool,
    createTaskListTool(board),
    createTaskStopTool(board, agentId),
    createTaskOutputTool(board, agentId, config),
    createTaskDelegateTool(board, agentId),
  ];
}
