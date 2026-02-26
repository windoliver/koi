/**
 * BrickDescriptor for @koi/webhook-delivery.
 *
 * Enables manifest auto-resolution for outbound webhook delivery.
 * Validates webhook endpoint configuration from the manifest.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";

function validateWebhookDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Webhook options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

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
  optionsValidator: validateWebhookDescriptorOptions,
  factory(): KoiMiddleware {
    throw new Error(
      "@koi/webhook-delivery requires an EventBackend. " +
        "Use createWebhookMiddleware(eventBackend) directly from the CLI.",
    );
  },
};
