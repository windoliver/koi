/**
 * Disclosure bundle — packages disclosure middleware + the `promote_tools`
 * companion tool. The bundle wires them so the model can call promote_tools
 * to lift tools from summary to full-schema state.
 *
 * The actual promotion logic lives in the middleware's `wrapToolCall`, which
 * has access to `TurnContext.session.sessionId` and routes the call to the
 * correct session. The Tool registered here is a fallback that returns an
 * error if reached — which only happens if the middleware was not registered.
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
  readonly error?: { readonly code: string; readonly message: string };
}

function createPromoteToolsTool(toolName: string): Tool {
  const descriptor: ToolDescriptor = createPromoteToolDescriptor(toolName);

  return {
    descriptor,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    async execute(_args: JsonObject): Promise<PromoteResult> {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `${toolName} requires the tool-disclosure middleware to be registered. The middleware intercepts this call and routes promotion to the correct session — without it, this fallback tool cannot determine which session is asking.`,
        },
      };
    },
  };
}

/**
 * Creates a disclosure bundle: middleware + `promote_tools` ComponentProvider.
 * Register `bundle.middleware` on the agent and `bundle.providers` on its ECS.
 *
 * If `config.promoteToolName` is set, the bundle plumbs that name through
 * the middleware, the provider, and the descriptor so they all agree on the
 * companion tool name. The default is `"promote_tools"`.
 */
export function createToolDisclosureBundle(config?: ToolDisclosureConfig): ToolDisclosureBundle {
  const toolName = config?.promoteToolName ?? PROMOTE_TOOL_NAME;
  const middleware = createToolDisclosureMiddleware(config);
  middleware.notifyCompanionRegistered();

  const provider = createSingleToolProvider({
    name: "tool-disclosure",
    toolName,
    createTool: () => createPromoteToolsTool(toolName),
  });

  return { middleware, providers: [provider] };
}
