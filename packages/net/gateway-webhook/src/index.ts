/**
 * @koi/gateway-webhook — Webhook HTTP ingestion (Layer 2)
 *
 * Converts POST requests into GatewayFrames dispatched through the gateway pipeline.
 * Depends on @koi/core and @koi/gateway-types only.
 */

export type {
  WebhookAuthenticator,
  WebhookAuthResult,
  WebhookConfig,
  WebhookDispatcher,
  WebhookServer,
} from "./webhook.js";
export { createWebhookServer } from "./webhook.js";
