/**
 * Webhook ComponentProvider — attaches webhook Tool components to an agent.
 *
 * Provides read-only visibility into configured webhook endpoints and their
 * delivery health. No CRUD — registration stays manifest-driven.
 */

import type { Agent, ComponentProvider, Tool, TrustTier, WebhookComponent } from "@koi/core";
import { toolToken, WEBHOOK } from "@koi/core";
import type { WebhookOperation } from "./constants.js";
import { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
import { createListTool } from "./tools/list.js";
import { createStatusTool } from "./tools/status.js";

export interface WebhookProviderConfig {
  readonly webhookComponent: WebhookComponent;
  readonly trustTier?: TrustTier;
  readonly prefix?: string;
  readonly operations?: readonly WebhookOperation[];
}

const TOOL_FACTORIES: Readonly<
  Record<WebhookOperation, (c: WebhookComponent, p: string, t: TrustTier) => Tool>
> = {
  list: createListTool,
  status: createStatusTool,
};

export function createWebhookProvider(config: WebhookProviderConfig): ComponentProvider {
  const {
    webhookComponent,
    trustTier = "verified",
    prefix = DEFAULT_PREFIX,
    operations = OPERATIONS,
  } = config;

  return {
    name: "webhook",

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        const tool = factory(webhookComponent, prefix, trustTier);
        return [toolToken(tool.descriptor.name) as string, tool] as const;
      });

      return new Map<string, unknown>([[WEBHOOK as string, webhookComponent], ...toolEntries]);
    },

    detach: async (_agent: Agent): Promise<void> => {
      // Webhook lifecycle managed externally — no-op
    },
  };
}
