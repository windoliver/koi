/**
 * DelegationComponentProvider — attaches delegation tools and the
 * DELEGATION singleton component to an agent during assembly.
 *
 * When `enabled: false`, attach() returns an empty map (no tools, no component).
 * The owning agent's ID is resolved from `agent.pid.id` during attach().
 */

import type {
  Agent,
  AgentId,
  ComponentProvider,
  DelegationComponent,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  DelegationVerifyResult,
  Tool,
  TrustTier,
} from "@koi/core";
import { DELEGATION } from "@koi/core";
import type { DelegationManager } from "./delegation-manager.js";
import type { DelegationOperation } from "./tools/constants.js";
import { DEFAULT_PREFIX, OPERATIONS } from "./tools/constants.js";
import { createDelegationGrantTool } from "./tools/grant.js";
import { createDelegationListTool } from "./tools/list.js";
import { createDelegationRevokeTool } from "./tools/revoke.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DelegationProviderConfig {
  readonly manager: DelegationManager;
  /** Operations to expose. Defaults to all: grant, revoke, list. */
  readonly operations?: readonly DelegationOperation[];
  /** Tool name prefix. Defaults to "delegation". */
  readonly prefix?: string;
  /** Trust tier for delegation tools. Defaults to "verified". */
  readonly trustTier?: TrustTier;
  /** When false, attach() returns empty map. Defaults to true. */
  readonly enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationProvider(config: DelegationProviderConfig): ComponentProvider {
  const {
    manager,
    operations = OPERATIONS,
    prefix = DEFAULT_PREFIX,
    trustTier = "verified",
    enabled = true,
  } = config;

  return {
    name: "delegation-tools",

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (!enabled) {
        return new Map();
      }

      const ownerAgentId: AgentId = agent.pid.id;
      const components = new Map<string, unknown>();

      // Attach tools for each requested operation
      const ops = new Set(operations);

      if (ops.has("grant")) {
        const tool: Tool = createDelegationGrantTool(manager, ownerAgentId, prefix, trustTier);
        components.set(`tool:${tool.descriptor.name}`, tool);
      }

      if (ops.has("revoke")) {
        const tool: Tool = createDelegationRevokeTool(manager, prefix, trustTier);
        components.set(`tool:${tool.descriptor.name}`, tool);
      }

      if (ops.has("list")) {
        const tool: Tool = createDelegationListTool(manager, ownerAgentId, prefix, trustTier);
        components.set(`tool:${tool.descriptor.name}`, tool);
      }

      // Attach DELEGATION singleton component
      const delegationComponent: DelegationComponent = {
        grant: async (
          scope: DelegationScope,
          delegateeId: AgentId,
          ttlMs?: number,
        ): Promise<DelegationGrant> => {
          const result = await manager.grant(ownerAgentId, delegateeId, scope, ttlMs);
          if (!result.ok) {
            throw new Error(`Delegation grant failed: ${result.error.message}`);
          }
          return result.value;
        },

        revoke: async (id: DelegationId, cascade?: boolean): Promise<void> => {
          await manager.revoke(id, cascade);
        },

        verify: async (id: DelegationId, toolId: string): Promise<DelegationVerifyResult> => {
          return manager.verify(id, toolId);
        },

        list: async (): Promise<readonly DelegationGrant[]> => {
          return manager.list(ownerAgentId);
        },
      };

      components.set(DELEGATION as string, delegationComponent);

      return components;
    },
  };
}
