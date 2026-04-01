/**
 * @koi/webhook-provider — Agent-facing webhook observability tools (Layer 2)
 *
 * Provides a ComponentProvider that wraps a WebhookComponent as Tool
 * components. Agents can list configured webhooks and check delivery
 * health — all read-only, no secrets exposed.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// types — re-exported from @koi/core for convenience
export type {
  OutboundWebhookConfig,
  WebhookComponent,
  WebhookEndpointHealth,
  WebhookSummary,
} from "@koi/core";

// domain-specific types
export type { WebhookOperation } from "./constants.js";

// constants
export { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
// tool factories — for advanced usage (custom tool composition)
export { createListTool } from "./tools/list.js";
export { createStatusTool } from "./tools/status.js";
// adapter
export { createWebhookComponentFromService } from "./webhook-component-adapter.js";
// provider
export type { WebhookProviderConfig } from "./webhook-component-provider.js";
export { createWebhookProvider } from "./webhook-component-provider.js";
