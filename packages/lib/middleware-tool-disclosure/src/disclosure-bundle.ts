/**
 * Disclosure bundle — packages disclosure middleware + the `promote_tools`
 * companion tool. The bundle wires them so the model can call promote_tools
 * to lift tools from summary to full-schema state.
 */

import type { JsonObject, MiddlewareBundle, Tool, ToolDescriptor } from "@koi/core";
import { createSingleToolProvider, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type {
  ToolDisclosureConfig,
  ToolDisclosureMiddleware,
} from "./tool-disclosure-middleware.js";
import {
  createPromoteToolDescriptor,
  createToolDisclosureMiddleware,
  PROMOTE_TOOL_NAME,
} from "./tool-disclosure-middleware.js";

export interface ToolDisclosureBundle extends MiddlewareBundle {
  readonly middleware: ToolDisclosureMiddleware;
}

interface PromoteResult {
  readonly ok: boolean;
  readonly promoted?: readonly string[];
  readonly message?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

function createPromoteToolsTool(middleware: ToolDisclosureMiddleware): Tool {
  const descriptor: ToolDescriptor = createPromoteToolDescriptor();

  return {
    descriptor,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    async execute(args: JsonObject): Promise<PromoteResult> {
      const names = args.names;
      if (!Array.isArray(names)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `${PROMOTE_TOOL_NAME} requires a 'names' array of tool name strings`,
          },
        };
      }
      const stringNames: readonly string[] = names.filter(
        (n: unknown): n is string => typeof n === "string",
      );
      if (stringNames.length === 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `${PROMOTE_TOOL_NAME} requires at least one tool name string`,
          },
        };
      }
      const promoted = middleware.promoteByName(stringNames);
      return {
        ok: true,
        promoted,
        message:
          promoted.length > 0
            ? `Promoted ${promoted.length} tool(s): ${promoted.join(", ")}. Full schemas are now available.`
            : "No tools were promoted. Check the tool names and try again.",
      };
    },
  };
}

/**
 * Creates a disclosure bundle: middleware + `promote_tools` ComponentProvider.
 * Register `bundle.middleware` on the agent and `bundle.providers` on its ECS.
 */
export function createToolDisclosureBundle(config?: ToolDisclosureConfig): ToolDisclosureBundle {
  const middleware = createToolDisclosureMiddleware(config);
  middleware.notifyCompanionRegistered();

  const provider = createSingleToolProvider({
    name: "tool-disclosure",
    toolName: PROMOTE_TOOL_NAME,
    createTool: () => createPromoteToolsTool(middleware),
  });

  return { middleware, providers: [provider] };
}
