/**
 * BrickDescriptor for @koi/webhook-delivery.
 *
 * Enables manifest auto-resolution for outbound webhook delivery.
 * Validates webhook endpoint configuration from the manifest.
 */

import type { KoiMiddleware } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";

/**
 * Descriptor for webhook delivery middleware.
 *
 * Note: The webhook middleware requires an EventBackend that cannot be
 * resolved from YAML alone. The factory throws — the CLI must inject the
 * EventBackend after resolution. This descriptor registers the name/alias
 * so the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "webhook",
  name: "@koi/webhook-delivery",
  aliases: ["webhook", "webhooks"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Webhook delivery"),
  factory(): KoiMiddleware {
    throw new Error(
      "@koi/webhook-delivery requires an EventBackend. " +
        "Use createWebhookMiddleware(eventBackend) directly from the CLI.",
    );
  },
};
