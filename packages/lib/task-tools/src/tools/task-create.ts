import type { JsonObject, ManagedTaskBoard, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

const schema = z.object({
  subject: z
    .string()
    .min(1)
    .describe("Short title shown in task lists (e.g. 'Implement auth module')"),
  description: z.string().min(1).describe("Full description of what needs to be done"),
  dependencies: z
    .array(z.string().min(1))
    .optional()
    .describe("Task IDs that must complete before this task can start"),
  active_form: z
    .string()
    .optional()
    .describe(
      "Present-continuous description shown in spinner while in_progress (e.g. 'Implementing auth module')",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Arbitrary metadata for this task (e.g. { kind: 'research' } to enable result schema validation).",
    ),
});

export function createTaskCreateTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_create",
      description:
        "Create a new task on the task board. Returns the created task. " +
        "Use task_list to see all tasks, task_update to mark progress.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const { subject, description, dependencies, active_form, metadata } = parsed.data;
      const id = await board.nextId();

      const result = await board.add({
        id: taskItemId(id),
        subject,
        description,
        ...(dependencies !== undefined
          ? { dependencies: dependencies.map((d) => taskItemId(d)) }
          : {}),
        ...(active_form !== undefined ? { activeForm: active_form } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });

      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }

      const task = result.value.get(id);
      if (task === undefined) {
        return { ok: false, error: `Task ${String(id)} was created but could not be retrieved` };
      }

      return { ok: true, task: toTaskSummary(task, result.value) };
    },
  };
}
