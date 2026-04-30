/**
 * Tool disclosure middleware — progressive disclosure for large tool sets.
 *
 * Above a configurable threshold, replaces full ToolDescriptor[] with summaries
 * (name + description, empty inputSchema) in the model request. Tools are
 * promoted to full descriptor level on demand via the `promote_tools` companion
 * tool. Below the threshold, all tools pass through unchanged.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolDescriptor,
  TurnContext,
} from "@koi/core";

/** Default tool count threshold below which disclosure is bypassed. */
export const DEFAULT_DISCLOSURE_THRESHOLD = 50;

/** Name of the companion tool that promotes summary-level tools to full descriptors. */
export const PROMOTE_TOOL_NAME = "promote_tools";

export interface ToolDisclosureConfig {
  /**
   * Tool count threshold. Below this, all tools pass through unchanged.
   * Above this, tools are exposed at summary level with on-demand promotion.
   * Default: 50.
   */
  readonly threshold?: number;
}

export interface ToolDisclosureMiddleware extends KoiMiddleware {
  /**
   * Promote tools by name. Adds names to the promoted set if they exist in
   * the most recent input descriptor list. Returns the names actually promoted.
   */
  readonly promoteByName: (names: readonly string[]) => readonly string[];
  /** Clear the promotion set. */
  readonly clearCache: () => void;
  /**
   * Notify the middleware that the `promote_tools` companion tool has been
   * registered. When set, `describeCapabilities` advertises the companion tool.
   * Without this call (standalone use), the capability fragment is suppressed.
   */
  readonly notifyCompanionRegistered: () => void;
}

function summarize(tool: ToolDescriptor): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {},
    ...(tool.tags !== undefined && tool.tags.length > 0 ? { tags: tool.tags } : {}),
  };
}

export function createToolDisclosureMiddleware(
  config?: ToolDisclosureConfig,
): ToolDisclosureMiddleware {
  const threshold = config?.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD;

  // Set of tool names currently in full-descriptor (promoted) state.
  // let justified: mutable set updated by promoteByName / clearCache.
  const promoted = new Set<string>();

  // Snapshot of the most recent input tool name set — used to validate
  // promotion requests without keeping descriptor copies around.
  // let justified: mutable, rebuilt on each above-threshold call.
  let knownNames: ReadonlySet<string> = new Set();

  // let justified: mutable flag — set once by notifyCompanionRegistered().
  let companionToolRegistered = false;

  function disclose(tools: readonly ToolDescriptor[]): readonly ToolDescriptor[] {
    if (tools.length <= threshold) return tools;
    const result: ToolDescriptor[] = [];
    const names = new Set<string>();
    for (const tool of tools) {
      names.add(tool.name);
      if (promoted.has(tool.name) || tool.name === PROMOTE_TOOL_NAME) {
        result.push(tool);
      } else {
        result.push(summarize(tool));
      }
    }
    knownNames = names;
    return result;
  }

  const middleware: ToolDisclosureMiddleware = {
    name: "tool-disclosure",
    priority: 50,
    phase: "intercept",

    wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (request.tools === undefined || request.tools.length <= threshold) {
        return next(request);
      }
      const disclosed = disclose(request.tools);
      return next({ ...request, tools: disclosed });
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (!companionToolRegistered) return undefined;
      return {
        label: "tool-disclosure",
        description: `${promoted.size} tools promoted to full descriptor. Use ${PROMOTE_TOOL_NAME} to load full schemas for tools you want to call.`,
      };
    },

    promoteByName(names: readonly string[]): readonly string[] {
      const ok: string[] = [];
      for (const name of names) {
        if (knownNames.has(name)) {
          promoted.add(name);
          ok.push(name);
        }
      }
      return ok;
    },

    clearCache(): void {
      promoted.clear();
    },

    notifyCompanionRegistered(): void {
      companionToolRegistered = true;
    },
  };

  return middleware;
}

/** Companion tool descriptor for `promote_tools`. */
export function createPromoteToolDescriptor(): ToolDescriptor {
  return {
    name: PROMOTE_TOOL_NAME,
    description:
      "Load full tool schemas for the named tools. Call this before using a tool whose inputSchema is empty (summary-level). Returns the list of successfully promoted tool names.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names to promote to full descriptor level.",
        },
      },
      required: ["names"],
    },
  };
}
