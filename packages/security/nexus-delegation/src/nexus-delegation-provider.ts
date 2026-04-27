/**
 * NexusDelegationProvider — ComponentProvider that attaches a Nexus-backed
 * DelegationComponent to an agent during assembly.
 *
 * The provider owns lifecycle of `NexusDelegationBackend`: it captures the
 * agent's pid.id at attach time and wires it into the backend so all grants
 * issued by that agent are bound to its identity.
 */

import type { Agent, ComponentProvider, DelegationComponent } from "@koi/core";
import { COMPONENT_PRIORITY, DELEGATION } from "@koi/core";
import type { NexusDelegationApi } from "./delegation-api.js";
import type { NexusDelegationBackendConfig } from "./nexus-delegation-backend.js";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusDelegationProviderConfig {
  /** Nexus REST client used by the backend. */
  readonly api: NexusDelegationApi;
  /**
   * Optional backend overrides. `api` and `agentId` are owned by the provider
   * and cannot be set here — the agent's pid.id is bound at attach time.
   */
  readonly backend?: Partial<Omit<NexusDelegationBackendConfig, "api" | "agentId">>;
  /**
   * Disable delegation attachment for this agent. When false, attach() returns
   * an empty map so the agent runs without a DELEGATION component (graceful
   * degradation).
   * @default true
   */
  readonly enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusDelegationProvider(
  config: NexusDelegationProviderConfig,
): ComponentProvider {
  const { api, backend = {}, enabled = true } = config;

  return {
    name: "delegation-nexus",
    priority: COMPONENT_PRIORITY.BUNDLED,
    async attach(agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (!enabled) return new Map();
      const delegation: DelegationComponent = createNexusDelegationBackend({
        ...backend,
        api,
        agentId: agent.pid.id,
      });
      return new Map([[DELEGATION as string, delegation]]);
    },
  };
}
