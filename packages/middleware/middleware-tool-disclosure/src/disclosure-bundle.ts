/**
 * Disclosure bundle — packages disclosure middleware + promote_tools companion tool.
 *
 * The bundle factory creates both and wires shared state (promoteByName)
 * through closure. Callers register middleware and providers through
 * their respective channels.
 */

import type { JsonObject, MiddlewareBundle, Tool } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import type {
  ToolDisclosureConfig,
  ToolDisclosureMiddleware,
} from "./tool-disclosure-middleware.js";
import {
  createPromoteToolDescriptor,
  createToolDisclosureMiddleware,
} from "./tool-disclosure-middleware.js";

// ---------------------------------------------------------------------------
// Bundle type
// ---------------------------------------------------------------------------

export interface ToolDisclosureBundle extends MiddlewareBundle {
  readonly middleware: ToolDisclosureMiddleware;
}

// ---------------------------------------------------------------------------
// Companion tool factory
// ---------------------------------------------------------------------------

/**
 * Creates the executable `promote_tools` Tool wired to the middleware's
 * `promoteByName()`. The agent calls this tool to load full schemas for
 * tools it wants to use.
 */
function createPromoteToolsTool(middleware: ToolDisclosureMiddleware): Tool {
  const descriptor = createPromoteToolDescriptor();

  return {
    descriptor,
    origin: "primordial",
    policy: { sandbox: false, capabilities: {} },
    async execute(args: JsonObject): Promise<unknown> {
      const names = args.names;
      if (!Array.isArray(names)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "promote_tools requires a 'names' array of tool name strings",
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
            message: "promote_tools requires at least one tool name string",
          },
        };
      }

      const promoted = await middleware.promoteByName(stringNames);
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

// ---------------------------------------------------------------------------
// Bundle factory
// ---------------------------------------------------------------------------

/**
 * Creates a complete tool disclosure bundle with middleware + companion tool.
 *
 * The `promote_tools` tool is automatically registered as an ECS component
 * so the agent can call it to load full schemas on demand.
 */
export function createToolDisclosureBundle(config: ToolDisclosureConfig): ToolDisclosureBundle {
  const middleware = createToolDisclosureMiddleware(config);
  middleware.notifyCompanionRegistered();

  const provider = createSingleToolProvider({
    name: "tool-disclosure",
    toolName: "promote_tools",
    createTool: () => createPromoteToolsTool(middleware),
  });

  return { middleware, providers: [provider] };
}
