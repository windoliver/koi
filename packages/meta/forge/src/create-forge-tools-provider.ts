/**
 * createForgeToolsProvider — builds a ComponentProvider that lazily creates
 * the 5 primordial forge tools + companion skill at attach() time.
 *
 * Shared between createForgeBootstrap() and createForgeConfiguredKoi().
 */

import type {
  Agent,
  ComponentProvider,
  ForgeStore,
  SandboxExecutor,
  StoreChangeNotifier,
} from "@koi/core";
import { skillToken } from "@koi/core";
import type { ForgeDeps } from "@koi/forge-tools";
import {
  createForgeEditTool,
  createForgeSkillTool,
  createForgeToolTool,
  createPromoteForgeTool,
  createSearchForgeTool,
} from "@koi/forge-tools";
import type { ForgeConfig, ForgePipeline } from "@koi/forge-types";
import { FORGE_COMPANION_SKILL } from "./forge-companion-skill.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForgeToolsProviderConfig {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
  readonly forgeConfig: ForgeConfig;
  readonly notifier?: StoreChangeNotifier | undefined;
  readonly pipeline?: ForgePipeline | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a ComponentProvider that lazily creates the 5 default forge tools
 * + companion skill at attach() time (when the agent entity is available).
 */
export function createForgeToolsProvider(config: ForgeToolsProviderConfig): ComponentProvider {
  return {
    name: "forge-tools",
    priority: 50,
    attach: async (agent: Agent) => {
      // Mutable counter incremented by onForgeConsumed callback.
      // let justified: mutable counter tracking forges consumed during session
      let forgeCount = 0;

      // Build ForgeDeps with runtime context from the agent entity
      const deps: ForgeDeps = {
        store: config.store,
        executor: config.executor,
        verifiers: [],
        config: config.forgeConfig,
        context: {
          agentId: agent.pid.id,
          depth: agent.pid.depth,
          sessionId: `session:${agent.pid.id}`,
          // Dynamic getter backed by mutable counter — incremented via onForgeConsumed
          get forgesThisSession() {
            return forgeCount;
          },
        },
        onForgeConsumed: (consumed: number) => {
          forgeCount += consumed;
        },
        // Spread conditionally to satisfy exactOptionalPropertyTypes —
        // optional props without `| undefined` cannot receive explicit undefined.
        ...(config.notifier !== undefined ? { notifier: config.notifier } : {}),
        ...(config.pipeline !== undefined ? { pipeline: config.pipeline } : {}),
      };

      const components = new Map<string, unknown>();
      // 5 default forge tools
      components.set("tool:search_forge", createSearchForgeTool(deps));
      components.set("tool:forge_skill", createForgeSkillTool(deps));
      components.set("tool:forge_tool", createForgeToolTool(deps));
      components.set("tool:forge_edit", createForgeEditTool(deps));
      components.set("tool:promote_forge", createPromoteForgeTool(deps));
      // Companion skill
      components.set(skillToken("forge-companion") as string, FORGE_COMPANION_SKILL);
      return components;
    },
  };
}
