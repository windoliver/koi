/**
 * InheritedComponentProvider — copies parent tools to a child agent,
 * optionally filtering by scope.
 *
 * Stateless: each `attach()` call independently reads the parent's tool set.
 * This makes concurrent spawning from the same parent safe — no shared mutable
 * state that could race between children assembled simultaneously.
 *
 * Scope filtering rules:
 * - scopeChecker returns "agent"    → tool is NOT inherited (agent-local)
 * - scopeChecker returns "zone"     → tool IS inherited
 * - scopeChecker returns "global"   → tool IS inherited
 * - scopeChecker returns undefined  → tool IS inherited (manifest-defined, no scope)
 * - no scopeChecker provided        → ALL parent tools are inherited
 *
 * Ordering guarantee: when multiple ComponentProviders run in a priority chain,
 * each provider's attach() is awaited before the next begins. Higher priority
 * (lower numeric value) providers run first. InheritedComponentProvider uses
 * COMPONENT_PRIORITY.BUNDLED (100) — the lowest priority — so custom/forge
 * providers always run before inheritance and can override inherited tools.
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
  /**
   * Optional tool denylist — tool names to exclude from inheritance.
   * Applied after scope filtering. Used by hook agents to prevent recursion.
   */
  readonly toolDenylist?: ReadonlySet<string> | undefined;
  /**
   * Optional tool allowlist — only inherited parent tools in this set pass through.
   * Mutually exclusive with toolDenylist. Applied after scope filtering.
   * Does not affect additionalTools injected via separate providers.
   */
  readonly toolAllowlist?: ReadonlySet<string> | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInheritedComponentProvider(
  config: InheritedComponentProviderConfig,
): ComponentProvider {
  return {
    name: "inherited",
    priority: COMPONENT_PRIORITY.BUNDLED,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
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

        // Exclude denylisted tools (e.g., spawn/agent for hook agents)
        if (config.toolDenylist?.has(toolName)) {
          continue;
        }

        // Exclude tools not in allowlist (when allowlist mode is active)
        if (config.toolAllowlist !== undefined && !config.toolAllowlist.has(toolName)) {
          continue;
        }

        // Include: zone, global, undefined (manifest-defined), or no scopeChecker
        inherited.set(tokenStr, tool);
      }

      return inherited;
    },
  };
}
