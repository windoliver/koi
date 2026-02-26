/**
 * @koi/webhook-delivery — Outbound webhook notifications (Layer 2)
 *
 * Captures agent events via middleware, delivers them as HTTP POST requests
 * to registered webhook URLs with HMAC-SHA256 signing, retry, circuit breaking,
 * and bounded concurrency.
 *
 * Imports from @koi/core (L0), @koi/errors (L0u), @koi/hash (L0u).
 */

export {
  DEFAULT_WEBHOOK_DELIVERY_CONFIG,
  validateWebhookDeliveryConfig,
  type WebhookDeliveryConfig,
} from "./config.js";
export { deliverWebhook } from "./deliver.js";
export {
  createWebhookDeliveryService,
  type WebhookDeliveryService,
  type WebhookDeliveryServiceDeps,
} from "./delivery-service.js";
export { descriptor } from "./descriptor.js";
export { createWebhookMiddleware } from "./middleware.js";
export { createSignatureHeaders, verifySignature } from "./signing.js";
export { validateWebhookUrl } from "./ssrf.js";
