/**
 * NexusDelegationProvider — ComponentProvider that attaches Nexus-backed
 * delegation to an agent during assembly.
 *
 * Key design decision (#1-A): The provider injects NEXUS_API_KEY into the
 * agent's ENV component, keeping L1 engine proof-agnostic. The engine never
 * discriminates on proof.kind.
 */

import type { Agent, AgentEnv, ComponentProvider, DelegationComponent } from "@koi/core";
import { DELEGATION, ENV } from "@koi/core";
import type { NexusDelegationApi } from "@koi/nexus-client";
import type { NexusDelegationBackendConfig } from "./nexus-delegation-backend.js";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusDelegationProviderConfig {
  /** Nexus delegation API client (shared — single HTTP connection pool). */
  readonly api: NexusDelegationApi;
  /** Nexus API key for the child agent — injected as NEXUS_API_KEY env var. */
  readonly nexusApiKey?: string;
  /** Override defaults for the backend. */
  readonly backend?: Partial<Omit<NexusDelegationBackendConfig, "api" | "agentId">>;
  /** When false, attach() returns empty map. Default: true. */
  readonly enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusDelegationProvider(
  config: NexusDelegationProviderConfig,
): ComponentProvider {
  const { api, nexusApiKey, backend = {}, enabled = true } = config;

  return {
    name: "delegation-nexus",

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (!enabled) {
        return new Map();
      }

      const components = new Map<string, unknown>();

      // Create backend for this agent
      const delegationBackend: DelegationComponent = createNexusDelegationBackend({
        api,
        agentId: agent.pid.id,
        ...backend,
      });

      // Attach DELEGATION singleton component
      components.set(DELEGATION as string, delegationBackend);

      // Inject NEXUS_API_KEY into agent env (Decision #1-A)
      // This keeps L1 engine proof-agnostic — it never inspects proof.kind
      if (nexusApiKey !== undefined && agent.has(ENV)) {
        const agentEnv = agent.component<AgentEnv>(ENV);
        if (agentEnv !== undefined) {
          const updatedEnv: AgentEnv = {
            values: { ...agentEnv.values, NEXUS_API_KEY: nexusApiKey },
            parentEnv: agentEnv.parentEnv,
          };
          components.set(ENV as string, updatedEnv);
        }
      }

      return components;
    },
  };
}
