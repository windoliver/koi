/**
 * NexusDelegationProvider — ComponentProvider that attaches Nexus-backed
 * delegation to an agent during assembly.
 *
 * The provider attaches the DELEGATION singleton component only.
 * Per-child API keys flow through DelegationGrant.proof.token, NOT through
 * the provider. In the Temporal path, the key flows via WorkerWorkflowConfig.
 * In the in-process path, spawn-child extracts it from the grant proof.
 *
 * The provider does NOT inject NEXUS_API_KEY into the agent's env — that
 * would leak the bootstrap/admin credential to every agent. Each child
 * receives its own attenuated key via the delegation grant.
 */

import type { Agent, ComponentProvider, DelegationComponent } from "@koi/core";
import { DELEGATION } from "@koi/core";
import type { NexusDelegationApi } from "@koi/nexus-client";
import type { NexusDelegationBackendConfig } from "./nexus-delegation-backend.js";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusDelegationProviderConfig {
  /** Nexus delegation API client (shared — single HTTP connection pool). */
  readonly api: NexusDelegationApi;
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
  const { api, backend = {}, enabled = true } = config;

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

      // Attach DELEGATION singleton component only.
      // Per-child Nexus API keys are NOT injected here — they flow through
      // the delegation grant's proof.token field per the capability model.
      components.set(DELEGATION as string, delegationBackend);

      return components;
    },
  };
}
