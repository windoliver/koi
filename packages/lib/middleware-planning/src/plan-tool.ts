/**
 * Plan tool descriptor and system prompt constant.
 */

import type { ToolDescriptor } from "@koi/core";

/**
 * Tool name. Namespaced with the `koi_` prefix to prevent collisions
 * with third-party or user-defined tools that might otherwise share
 * the unqualified `koi_plan_write` name. Collision would be a real
 * security issue: a same-named provider could silently inherit the
 * planning auto-allow policy rule, and the planning middleware's
 * wrapToolCall would also hijack the other tool's invocation.
 */
export const WRITE_PLAN_TOOL_NAME = "koi_plan_write" as const;

export const WRITE_PLAN_DESCRIPTOR: ToolDescriptor = {
  name: WRITE_PLAN_TOOL_NAME,
  description:
    "Create or update a structured plan for multi-step tasks. Replaces the entire plan atomically. Call at most once per response.",
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What needs to be done" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["plan"],
  },
};

export const PLAN_SYSTEM_PROMPT = `## Planning
For complex tasks (3+ steps), use \`write_plan\` to create a structured plan.
Rules:
- Call \`write_plan\` at most once per response — never in parallel
- Mark items "in_progress" before starting work on them
- Mark items "completed" immediately when done
- Revise the plan freely as you learn more
- Skip for simple, few-step requests` as const;
