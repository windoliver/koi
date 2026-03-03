/**
 * ComponentProvider that registers/deregisters agents in Nexus.
 *
 * On attach: registers the agent in Nexus, writes AGENT.json card from manifest.
 * On detach: transitions agent to terminated in Nexus.
 */

import type { Agent, AttachResult, ComponentProvider } from "@koi/core";
import type { NexusRegistryConfig } from "./config.js";
import { nexusDeleteAgent, nexusRegisterAgent, nexusTransition } from "./nexus-client.js";
import { encodeKoiStatus, mapKoiToNexus } from "./state-mapping.js";

/**
 * Create a ComponentProvider that manages Nexus agent registration.
 *
 * On attach: registers agent in Nexus with manifest-derived metadata.
 * On detach: transitions agent to terminated state in Nexus.
 */
export function createNexusRegistryProvider(config: NexusRegistryConfig): ComponentProvider {
  return {
    name: "registry-nexus",

    async attach(agent: Agent): Promise<AttachResult> {
      const id = agent.pid.id;
      const manifest = agent.manifest;

      const metadata: Record<string, unknown> = {
        agentType: agent.pid.type,
        manifestName: manifest.name,
        description: manifest.description ?? "",
        registeredAt: Date.now(),
        ...encodeKoiStatus({
          phase: agent.state,
          generation: 0,
          conditions: [],
          lastTransitionAt: Date.now(),
        }),
      };

      if (agent.pid.parent !== undefined) {
        metadata.parentId = agent.pid.parent;
      }

      const registerParams: {
        readonly agent_id: string;
        readonly name: string;
        readonly zone_id?: string;
        readonly metadata: Readonly<Record<string, unknown>>;
      } = {
        agent_id: id,
        name: manifest.name,
        metadata,
        ...(config.zoneId !== undefined ? { zone_id: config.zoneId } : {}),
      };
      await nexusRegisterAgent(config, registerParams);

      // Transition from UNKNOWN → CONNECTED
      const nexusState = mapKoiToNexus(agent.state);
      await nexusTransition(config, id, nexusState, 0);

      // No components to attach — this provider only manages Nexus lifecycle
      return {
        components: new Map(),
        skipped: [],
      };
    },

    async detach(agent: Agent): Promise<void> {
      await nexusDeleteAgent(config, agent.pid.id);
    },
  };
}
