/**
 * ComponentProvider that attaches handoff tools to an agent.
 */

import type { Agent, ComponentProvider } from "@koi/core";
import { skillToken } from "@koi/core";
import { createAcceptTool } from "./accept-tool.js";
import { createPrepareTool } from "./prepare-tool.js";
import { HANDOFF_SKILL, HANDOFF_SKILL_NAME } from "./skill.js";
import type { HandoffConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches prepare_handoff and
 * accept_handoff tools. Optionally binds the store to the registry
 * for cleanup on agent termination.
 *
 * Tools are created once and cached — subsequent attach() calls
 * return the same instances.
 */
export function createHandoffProvider(config: HandoffConfig): ComponentProvider {
  // let justified: mutable cache (set once on first attach)
  let cached: ReadonlyMap<string, unknown> | undefined;

  // Bind registry if provided (Decision #15)
  if (config.registry !== undefined) {
    config.store.bindRegistry(config.registry);
  }

  return {
    name: "handoff",

    async attach(agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (agent.pid.id !== config.agentId) {
        throw new Error(
          `Provider is single-agent; cannot attach agent ${agent.pid.id} while agent ${config.agentId} is attached.`,
        );
      }

      if (cached !== undefined) return cached;

      const prepareTool = createPrepareTool({
        store: config.store,
        agentId: config.agentId,
        registry: config.registry,
        onEvent: config.onEvent,
      });

      const acceptTool = createAcceptTool({
        store: config.store,
        agentId: config.agentId,
        onEvent: config.onEvent,
      });

      const components = new Map<string, unknown>();
      components.set("tool:prepare_handoff", prepareTool);
      components.set("tool:accept_handoff", acceptTool);
      components.set(skillToken(HANDOFF_SKILL_NAME) as string, HANDOFF_SKILL);
      cached = components;
      return cached;
    },
  };
}
