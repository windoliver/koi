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
  /**
   * Optional board getter for detecting synchronous completion.
   * When provided and all tasks are completed after onPlanCreated returns,
   * the tool response includes an explicit synthesis prompt so the LLM
   * calls task_synthesize immediately.
   */
  readonly getTaskBoard?: (() => TaskBoardSnapshot) | undefined;
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
          delegation: {
            type: "string",
            enum: ["self", "spawn"],
            description:
              'How this task is executed. "self" (default): you complete it yourself via task_complete. ' +
              '"spawn": dispatched to a worker agent automatically.',
          },
          agentType: {
            type: "string",
            description:
              'For spawn-delegated tasks, the type of worker agent to use (e.g. "researcher", "coder"). ' +
              'Defaults to "worker" if omitted.',
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
  readonly delegation?: unknown;
  readonly agentType?: unknown;
}

interface ValidatedTask {
  readonly id: TaskItemId;
  readonly description: string;
  readonly dependencies: readonly TaskItemId[];
  readonly delegation: "self" | "spawn";
  readonly agentType: string | undefined;
}

/** Check whether a dependency graph contains a cycle using iterative DFS. */
function hasCycle(tasks: readonly ValidatedTask[]): boolean {
  const adjacency = new Map<TaskItemId, readonly TaskItemId[]>();
  for (const t of tasks) {
    adjacency.set(t.id, t.dependencies);
  }

  // 0 = unvisited, 1 = in-stack, 2 = done
  const state = new Map<TaskItemId, 0 | 1 | 2>();
  for (const t of tasks) {
    state.set(t.id, 0);
  }

  for (const t of tasks) {
    if (state.get(t.id) === 2) continue;

    // Iterative DFS with explicit stack
    const stack: { readonly id: TaskItemId; readonly phase: "enter" | "exit" }[] = [
      { id: t.id, phase: "enter" },
    ];

    while (stack.length > 0) {
      // biome-lint: length check above guarantees element exists
      const frame = stack[stack.length - 1] as (typeof stack)[number];
      if (frame.phase === "exit") {
        stack.pop();
        state.set(frame.id, 2);
        continue;
      }

      // Replace enter with exit, then push children
      (stack as { id: TaskItemId; phase: "enter" | "exit" }[])[stack.length - 1] = {
        id: frame.id,
        phase: "exit",
      };

      if (state.get(frame.id) === 1) {
        // Already in-stack from a different path — cycle detected
        return true;
      }

      state.set(frame.id, 1);

      const deps = adjacency.get(frame.id) ?? [];
      for (const dep of deps) {
        const depState = state.get(dep);
        if (depState === 1) return true; // back-edge → cycle
        if (depState === 0) {
          stack.push({ id: dep, phase: "enter" });
        }
      }
    }
  }

  return false;
}

type TaskValidationResult =
  | { readonly ok: true; readonly tasks: readonly ValidatedTask[] }
  | { readonly ok: false; readonly error: string };

function validateTasks(raw: unknown): TaskValidationResult {
  if (!Array.isArray(raw)) return { ok: false, error: "Tasks must be an array." };

  const parsed: ValidatedTask[] = [];
  const seenIds = new Set<string>();

  for (let idx = 0; idx < (raw as readonly unknown[]).length; idx++) {
    const item = (raw as readonly RawTaskInput[])[idx];
    if (typeof item?.id !== "string" || typeof item?.description !== "string") {
      return {
        ok: false,
        error: `Task at index ${String(idx)} has invalid id or description: expected strings.`,
      };
    }

    // Duplicate ID check
    if (seenIds.has(item.id)) {
      return { ok: false, error: `Duplicate task ID: "${item.id}".` };
    }
    seenIds.add(item.id);

    const deps = Array.isArray(item.dependencies)
      ? (item.dependencies as readonly unknown[])
          .filter((d): d is string => typeof d === "string")
          .map(taskItemId)
      : [];
    const delegation = item.delegation === "spawn" ? "spawn" : "self";
    const agentType = typeof item.agentType === "string" ? item.agentType : undefined;
    parsed.push({
      id: taskItemId(item.id),
      description: item.description,
      dependencies: deps,
      delegation,
      agentType,
    });
  }

  // Check for dependencies referencing non-existent task IDs
  for (const task of parsed) {
    for (const dep of task.dependencies) {
      if (!seenIds.has(dep)) {
        return {
          ok: false,
          error: `Task "${task.id}" depends on unknown task ID: "${dep}".`,
        };
      }
    }
  }

  // Cycle detection
  if (hasCycle(parsed)) {
    return { ok: false, error: "Task dependency graph contains a cycle." };
  }

  return { ok: true, tasks: parsed };
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
        const validation = validateTasks(args.tasks);
        if (!validation.ok) {
          return { error: validation.error };
        }
        const tasks = validation.tasks;
        if (tasks.length === 0) {
          return { error: "No valid tasks provided. Each task needs an id and description." };
        }

        const snapshot: TaskBoardSnapshot = {
          items: tasks.map((t) => ({
            id: t.id,
            description: t.description,
            dependencies: t.dependencies,
            delegation: t.delegation,
            ...(t.agentType !== undefined ? { agentType: t.agentType } : {}),
            priority: 0,
            maxRetries: 3,
            retries: 0,
            // "assigned" for self-delegation — the copilot IS the worker.
            // "pending" for spawn-delegation — the bridge will assign a worker.
            status: t.delegation === "spawn" ? "pending" : "assigned",
          })),
          results: [],
        };

        await config.onPlanCreated(snapshot);

        // Check if all tasks completed during dispatch (synchronous spawn).
        // When workers finish within onPlanCreated, the board is already
        // up-to-date. Return an explicit synthesis prompt so the LLM calls
        // task_synthesize instead of stopping or calling task_status.
        if (config.getTaskBoard !== undefined) {
          const board = config.getTaskBoard();
          const completedCount = board.items.filter((i) => i.status === "completed").length;
          const total = board.items.length;
          if (completedCount === total && total > 0) {
            return {
              status: "plan_completed",
              taskCount: total,
              completedCount,
              message:
                `All ${String(total)} tasks completed successfully. ` +
                "Call task_synthesize now to merge and present the results to the user.",
            };
          }
        }

        return {
          status: "plan_created",
          taskCount: tasks.length,
          message: `Created autonomous plan with ${tasks.length} tasks.`,
        };
      },
    }),
  });
}
