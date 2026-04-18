/**
 * Tool registrations for `koi_plan_save` and `koi_plan_load`.
 *
 * The providers' `execute` is a defensive fallback — the actual work
 * happens in the plan-persist middleware's `wrapToolCall`. Without the
 * middleware wired, calls to these tools throw a clear configuration
 * error instead of silently no-oping (mirrors the safety pattern in
 * `@koi/middleware-planning`'s plan-tool-provider).
 */

import type {
  ComponentProvider,
  JsonObject,
  Tool,
  ToolDescriptor,
  ToolExecuteOptions,
} from "@koi/core";
import { createSingleToolProvider, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

export const PLAN_SAVE_TOOL_NAME = "koi_plan_save" as const;
export const PLAN_LOAD_TOOL_NAME = "koi_plan_load" as const;

const PLAN_SAVE_DESCRIPTION =
  "Persist the latest write_plan output to disk under .koi/plans/<timestamp>-<slug>.md. " +
  "Use to checkpoint a long-running plan that should survive a session restart. " +
  "Optional `slug` controls the filename suffix; sluggified human-readable string recommended.";

const PLAN_LOAD_DESCRIPTION =
  "Read a previously persisted plan from disk and return its items. " +
  "After receiving the items call write_plan with them to hydrate this session's plan state.";

export const PLAN_SAVE_DESCRIPTOR: ToolDescriptor = {
  name: PLAN_SAVE_TOOL_NAME,
  description: PLAN_SAVE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Optional human-readable label, e.g. 'auth-refactor'. Lowercase letters, digits, single dashes only (1-48 chars).",
      },
    },
  },
};

export const PLAN_LOAD_DESCRIPTOR: ToolDescriptor = {
  name: PLAN_LOAD_TOOL_NAME,
  description: PLAN_LOAD_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to a plan file under the configured plans directory. Absolute or relative to the project root.",
      },
    },
    required: ["path"],
  },
};

function defensiveExecute(
  toolName: string,
): (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown> {
  return async (_args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> => {
    throw KoiRuntimeError.from(
      "INTERNAL",
      `${toolName} was invoked but @koi/middleware-plan-persist is not registered; add createPlanPersistMiddleware().middleware to the middleware chain`,
    );
  };
}

export function createPlanSaveProvider(): ComponentProvider {
  return createSingleToolProvider({
    name: "plan-save-tool",
    toolName: PLAN_SAVE_TOOL_NAME,
    createTool: (): Tool => ({
      descriptor: PLAN_SAVE_DESCRIPTOR,
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      execute: defensiveExecute(PLAN_SAVE_TOOL_NAME),
    }),
  });
}

export function createPlanLoadProvider(): ComponentProvider {
  return createSingleToolProvider({
    name: "plan-load-tool",
    toolName: PLAN_LOAD_TOOL_NAME,
    createTool: (): Tool => ({
      descriptor: PLAN_LOAD_DESCRIPTOR,
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      execute: defensiveExecute(PLAN_LOAD_TOOL_NAME),
    }),
  });
}
