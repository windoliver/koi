/**
 * ComponentProvider factory for knowledge vault.
 *
 * Creates an ECS ComponentProvider that attaches a KNOWLEDGE component
 * and optionally a `query_knowledge` tool to agents during assembly.
 */

import type { AttachResult, ComponentProvider } from "@koi/core";
import type { KnowledgeComponent, KnowledgeVaultConfig } from "./types.js";
import { KNOWLEDGE } from "./types.js";
import type { VaultService } from "./vault-service.js";
import { createVaultService } from "./vault-service.js";

/**
 * Create a ComponentProvider that hydrates agents with knowledge vault access.
 *
 * On `attach()`, scans configured sources, builds the BM25 index, and
 * provides a `KNOWLEDGE` component for runtime queries.
 */
export function createKnowledgeVaultProvider(config: KnowledgeVaultConfig): ComponentProvider {
  return {
    name: "knowledge-vault",

    attach: async (): Promise<AttachResult> => {
      const result = await createVaultService(config);

      if (!result.ok) {
        return {
          components: new Map<string, unknown>(),
          skipped: [
            {
              name: "knowledge-vault",
              reason: result.error.message,
            },
          ],
        };
      }

      const service: VaultService = result.value;

      const component: KnowledgeComponent = {
        sources: service.sources,
        query: service.query,
        refresh: service.refresh,
      };

      const components = new Map<string, unknown>([[KNOWLEDGE as string, component]]);

      return { components, skipped: [] };
    },

    detach: async (): Promise<void> => {
      // No timers or watchers in v1 — no-op
    },
  };
}
