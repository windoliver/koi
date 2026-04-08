/**
 * Tool factory for `TodoWrite` — reads and writes the agent's in-conversation to-do list.
 *
 * Stores an in-memory list of TodoItems keyed per agent. The model provides
 * the full replacement list on every write. Auto-clears when all items are completed.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  /** Present-continuous text for spinner display, e.g. "Running tests". */
  readonly activeForm?: string | undefined;
}

export interface TodoToolConfig {
  readonly getItems: () => readonly TodoItem[];
  readonly setItems: (items: readonly TodoItem[]) => void;
  readonly policy?: ToolPolicy | undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

function isTodoStatus(value: unknown): value is TodoStatus {
  return VALID_STATUSES.includes(value as TodoStatus);
}

function parseTodoItem(
  raw: unknown,
  index: number,
): TodoItem | { error: string; code: "VALIDATION" } {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `todos[${String(index)}] must be an object`, code: "VALIDATION" };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { error: `todos[${String(index)}].id must be a non-empty string`, code: "VALIDATION" };
  }
  if (typeof obj.content !== "string" || obj.content.length === 0) {
    return {
      error: `todos[${String(index)}].content must be a non-empty string`,
      code: "VALIDATION",
    };
  }
  if (!isTodoStatus(obj.status)) {
    return {
      error: `todos[${String(index)}].status must be one of: ${VALID_STATUSES.join(", ")}`,
      code: "VALIDATION",
    };
  }
  if (obj.activeForm !== undefined && typeof obj.activeForm !== "string") {
    return {
      error: `todos[${String(index)}].activeForm must be a string`,
      code: "VALIDATION",
    };
  }

  return {
    id: obj.id,
    content: obj.content,
    status: obj.status,
    ...(obj.activeForm !== undefined && { activeForm: obj.activeForm as string }),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTodoTool(config: TodoToolConfig): Tool {
  const { setItems, policy = DEFAULT_UNSANDBOXED_POLICY } = config;

  return {
    descriptor: {
      name: "TodoWrite",
      description:
        "Write the agent's to-do list. Pass the complete replacement list — all current " +
        "items will be replaced. Items are auto-cleared when all reach 'completed' status. " +
        "Use status 'in_progress' for the task currently being worked on (max 1 at a time).",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Complete replacement list of to-do items.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Stable item identifier. Use a short slug, e.g. 'implement-auth'.",
                },
                content: {
                  type: "string",
                  description: "Task description (1 sentence).",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current status.",
                },
                activeForm: {
                  type: "string",
                  description:
                    "Present-continuous verb phrase for spinner display, e.g. 'Running tests'.",
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const raw = args.todos;
      if (!Array.isArray(raw)) {
        return { error: "todos must be an array", code: "VALIDATION" };
      }

      const items: TodoItem[] = [];
      for (let i = 0; i < raw.length; i++) {
        const parsed = parseTodoItem(raw[i], i);
        if ("error" in parsed) return parsed;
        items.push(parsed);
      }

      // Auto-clear when all items completed
      const allDone = items.length > 0 && items.every((item) => item.status === "completed");
      const next: readonly TodoItem[] = allDone ? [] : items;
      setItems(next);

      return { todos: next, cleared: allDone };
    },
  };
}
