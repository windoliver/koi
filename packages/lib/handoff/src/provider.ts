/**
 * ComponentProvider that attaches handoff tools to an agent.
 */

import type { Agent, ComponentProvider } from "@koi/core";
import { toolToken } from "@koi/core";
import { createAcceptTool } from "./accept-tool.js";
import { createPrepareTool } from "./prepare-tool.js";
import type { HandoffConfig } from "./types.js";

export function createHandoffProvider(config: HandoffConfig): ComponentProvider {
  // let justified: cache populated on first attach
  let cached: ReadonlyMap<string, unknown> | undefined;

  if (config.registry !== undefined) {
    config.store.bindRegistry(config.registry);
  }

  return {
    name: "handoff",

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
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
      components.set(toolToken("prepare_handoff") as string, prepareTool);
      components.set(toolToken("accept_handoff") as string, acceptTool);
      cached = components;
      return cached;
    },
  };
}
