/**
 * Webhook ComponentProvider — attaches webhook Tool components to an agent.
 *
 * Provides read-only visibility into configured webhook endpoints and their
 * delivery health. No CRUD — registration stays manifest-driven.
 */

import type { ComponentProvider, Tool, ToolPolicy, WebhookComponent } from "@koi/core";
import { createServiceProvider, DEFAULT_UNSANDBOXED_POLICY, WEBHOOK } from "@koi/core";
import type { WebhookOperation } from "./constants.js";
import { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
import { createListTool } from "./tools/list.js";
import { createStatusTool } from "./tools/status.js";

export interface WebhookProviderConfig {
  readonly webhookComponent: WebhookComponent;
  readonly policy?: ToolPolicy;
  readonly prefix?: string;
  readonly operations?: readonly WebhookOperation[];
}

const TOOL_FACTORIES: Readonly<
  Record<WebhookOperation, (c: WebhookComponent, p: string, t: ToolPolicy) => Tool>
> = {
  list: createListTool,
  status: createStatusTool,
};

export function createWebhookProvider(config: WebhookProviderConfig): ComponentProvider {
  const {
    webhookComponent,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = DEFAULT_PREFIX,
    operations = OPERATIONS,
  } = config;

  return createServiceProvider({
    name: "webhook",
    singletonToken: WEBHOOK,
    backend: webhookComponent,
    operations,
    factories: TOOL_FACTORIES,
    policy,
    prefix,
  });
}
