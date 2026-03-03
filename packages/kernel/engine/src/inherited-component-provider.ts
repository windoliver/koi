/**
 * InheritedComponentProvider — copies parent tools to a child agent,
 * optionally filtering by scope.
 *
 * Shared per parent: cached on first `attach()` call, subsequent children
 * of the same parent skip the filter pass.
 *
 * Scope filtering rules:
 * - scopeChecker returns "agent"    → tool is NOT inherited (agent-local)
 * - scopeChecker returns "zone"     → tool IS inherited
 * - scopeChecker returns "global"   → tool IS inherited
 * - scopeChecker returns undefined  → tool IS inherited (manifest-defined, no scope)
 * - no scopeChecker provided        → ALL parent tools are inherited
 */

import type { Agent, ComponentProvider, ForgeScope, Tool } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InheritedComponentProviderConfig {
  /** The parent agent whose tools are inherited. */
  readonly parent: Agent;
  /**
   * Optional scope checker for filtering inherited tools.
   * Given a tool name, returns its ForgeScope or undefined (manifest-defined).
   * Tools with scope "agent" are excluded from inheritance.
   */
  readonly scopeChecker?: (toolName: string) => ForgeScope | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInheritedComponentProvider(
  config: InheritedComponentProviderConfig,
): ComponentProvider {
  // let justified: mutable cache, set once on first attach(), shared across children
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "inherited",
    priority: COMPONENT_PRIORITY.BUNDLED,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (cached !== undefined) return cached;

      const parentTools = config.parent.query<Tool>("tool:");
      const inherited = new Map<string, unknown>();

      for (const [token, tool] of parentTools) {
        const tokenStr = token as string;
        const toolName = tokenStr.slice("tool:".length);
        const scope = config.scopeChecker?.(toolName);

        // Exclude agent-scoped tools — they are local to the parent
        if (scope === "agent") {
          continue;
        }

        // Include: zone, global, undefined (manifest-defined), or no scopeChecker
        inherited.set(tokenStr, tool);
      }

      cached = inherited;
      return cached;
    },
  };
}
