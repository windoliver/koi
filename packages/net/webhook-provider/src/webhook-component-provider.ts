/**
 * Webhook ComponentProvider — attaches webhook Tool components to an agent.
 *
 * Provides read-only visibility into configured webhook endpoints and their
 * delivery health. No CRUD — registration stays manifest-driven.
 */

import type { ComponentProvider, Tool, TrustTier, WebhookComponent } from "@koi/core";
import { createServiceProvider, WEBHOOK } from "@koi/core";
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

  return createServiceProvider({
    name: "webhook",
    singletonToken: WEBHOOK,
    backend: webhookComponent,
    operations,
    factories: TOOL_FACTORIES,
    trustTier,
    prefix,
  });
}
