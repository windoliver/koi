/**
 * plan_autonomous tool — self-escalation for autonomous agent workflows (Decision 7B).
 *
 * Registered at assembly time via ComponentProvider. When the agent calls
 * `plan_autonomous`, it creates a TaskBoardSnapshot and fires the
 * `onPlanCreated` callback to activate autonomous middleware.
 */

import type { ComponentProvider, JsonObject, TaskBoardSnapshot, TaskItemId } from "@koi/core";
import { createSingleToolProvider, DEFAULT_UNSANDBOXED_POLICY, taskItemId } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PlanAutonomousConfig {
  /** Called when the agent creates an autonomous plan. */
  readonly onPlanCreated: (plan: TaskBoardSnapshot) => void | Promise<void>;
  /** ComponentProvider priority. Default: BUNDLED (100). */
  readonly priority?: number | undefined;
}

// ---------------------------------------------------------------------------
// Input schema for the plan_autonomous tool
// ---------------------------------------------------------------------------

const PLAN_AUTONOMOUS_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "Short unique slug for this task (e.g. 'research-api', 'write-tests', 't1'). " +
              "Referenced by other tasks in their dependencies array.",
          },
          description: {
            type: "string",
            description:
              "Clear, actionable instruction: what to do and what the expected output is. " +
              "Should be self-contained — a sub-agent reading only this field must know what to produce.",
          },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description:
              "IDs of tasks that must complete before this one can start. " +
              "Omit or pass [] for tasks that can run immediately. " +
              "Tasks sharing no dependencies may run in parallel.",
          },
        },
        required: ["id", "description"],
      },
      description: "The list of tasks to execute. Must contain at least one task.",
    },
  },
  required: ["tasks"],
};

// ---------------------------------------------------------------------------
// Task input validation
// ---------------------------------------------------------------------------

interface RawTaskInput {
  readonly id?: unknown;
  readonly description?: unknown;
  readonly dependencies?: unknown;
}

interface ValidatedTask {
  readonly id: TaskItemId;
  readonly description: string;
  readonly dependencies: readonly TaskItemId[];
}

function validateTasks(raw: unknown): readonly ValidatedTask[] {
  if (!Array.isArray(raw)) return [];
  const result: ValidatedTask[] = [];
  for (const item of raw as readonly RawTaskInput[]) {
    if (typeof item?.id !== "string" || typeof item?.description !== "string") continue;
    const deps = Array.isArray(item.dependencies)
      ? (item.dependencies as readonly unknown[])
          .filter((d): d is string => typeof d === "string")
          .map(taskItemId)
      : [];
    result.push({
      id: taskItemId(item.id),
      description: item.description,
      dependencies: deps,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a ComponentProvider that registers the `plan_autonomous` tool at assembly time.
 * When called, it creates a TaskBoardSnapshot and fires the onPlanCreated callback.
 */
export function createPlanAutonomousProvider(config: PlanAutonomousConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "plan-autonomous-provider",
    toolName: "plan_autonomous",
    priority: config.priority,
    createTool: () => ({
      descriptor: {
        name: "plan_autonomous",
        description:
          "Break a complex task into smaller subtasks for autonomous execution. " +
          "Use when a task requires multiple steps, research, or parallel work that " +
          "would benefit from independent sub-agents.\n\n" +
          "How to use:\n" +
          "1. Decompose the goal into focused subtasks — each with one clear outcome.\n" +
          "2. Assign a unique id to each task (e.g. 'research', 'impl', 'test').\n" +
          "3. Set dependencies to enforce ordering: if task B needs output from task A, " +
          "add A's id to B's dependencies array.\n" +
          "4. Tasks with no shared dependencies run in parallel automatically.\n\n" +
          "Example:\n" +
          "  tasks: [\n" +
          '    { id: "research", description: "Find best JWT library for our stack" },\n' +
          '    { id: "impl", description: "Implement JWT auth middleware", dependencies: ["research"] },\n' +
          '    { id: "test", description: "Write unit tests for auth middleware", dependencies: ["research"] },\n' +
          '    { id: "docs", description: "Update API docs with auth endpoints", dependencies: ["impl", "test"] }\n' +
          "  ]\n\n" +
          "In this example: research runs first, then impl and test run in parallel, " +
          "then docs runs last. Progress is checkpointed automatically and survives interruptions.",
        inputSchema: PLAN_AUTONOMOUS_SCHEMA,
      },
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      execute: async (args: JsonObject): Promise<unknown> => {
        const tasks = validateTasks(args.tasks);
        if (tasks.length === 0) {
          return { error: "No valid tasks provided. Each task needs an id and description." };
        }

        const snapshot: TaskBoardSnapshot = {
          items: tasks.map((t) => ({
            id: t.id,
            description: t.description,
            dependencies: t.dependencies,
            priority: 0,
            maxRetries: 3,
            retries: 0,
            status: "pending",
          })),
          results: [],
        };

        await config.onPlanCreated(snapshot);
        return {
          status: "plan_created",
          taskCount: tasks.length,
          message: `Created autonomous plan with ${tasks.length} tasks.`,
        };
      },
    }),
  });
}
