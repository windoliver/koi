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
        "Create a task on the task board. Use PROACTIVELY to plan multi-step work — do not wait for the user to ask. " +
        "\n\nUse when: the user's request needs 3+ distinct steps, spans multiple files, or benefits from visible progress (e.g. " +
        "'refactor X and run tests', 'rename Y across the codebase', 'add feature Z with tests and docs'). " +
        "Create one task per concrete step BEFORE starting the first step. Each subject should be short and imperative " +
        "('Add JSDoc to math.ts'); pair with active_form for the spinner ('Adding JSDoc to math.ts'). " +
        "\n\nDo NOT use for: single-file edits, 1-2 step work, pure Q&A, or informational requests. " +
        "\n\nAfter creating the plan, task_update the first task to 'in_progress' (only ONE may be in_progress at a time), " +
        "do the work, task_update it to 'completed' immediately, then start the next. Use task_list to review progress.",
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
