import type { JsonObject, ManagedTaskBoard, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

const schema = z.object({
  status: z
    .enum(["pending", "in_progress", "completed", "failed", "killed"])
    .optional()
    .describe("Filter tasks by status"),
  assigned_to: z.string().optional().describe("Filter tasks by assignee agent ID"),
  updated_since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Unix ms timestamp. Return only tasks updated after this time. " +
        "Store the timestamp from your last poll to skip unchanged tasks.",
    ),
});

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  failed: 3,
  killed: 4,
};

export function createTaskListTool(board: ManagedTaskBoard): Tool {
  return {
    descriptor: {
      name: "task_list",
      description:
        "List tasks on the board with optional status or assignee filters. " +
        "Returns TaskSummary objects (use task_get for full details including metadata and timestamps). " +
        "Results are ordered: in_progress first, then pending, then terminal states.",
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

      const { status, assigned_to, updated_since } = parsed.data;
      const snapshot = board.snapshot();
      let tasks = snapshot.all();

      if (status !== undefined) {
        tasks = tasks.filter((t) => t.status === status);
      }
      if (assigned_to !== undefined) {
        tasks = tasks.filter((t) => t.assignedTo === assigned_to);
      }
      if (updated_since !== undefined) {
        tasks = tasks.filter((t) => t.updatedAt > updated_since);
      }

      const sorted = [...tasks].sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5),
      );

      return {
        ok: true,
        tasks: sorted.map((t) => toTaskSummary(t, snapshot)),
        total: sorted.length,
      };
    },
  };
}
