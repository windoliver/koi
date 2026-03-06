/**
 * BrickDescriptor for @koi/middleware-guided-retry.
 *
 * Enables manifest auto-resolution: validates initial constraint options,
 * then creates the guided retry middleware.
 */

import type { BacktrackConstraint, JsonObject, KoiMiddleware } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createGuidedRetryMiddleware } from "./guided-retry.js";
import type { GuidedRetryConfig } from "./types.js";

/**
 * Parses a BacktrackConstraint from raw JSON options, if present.
 */
function parseInitialConstraint(options: JsonObject): BacktrackConstraint | undefined {
  const raw = options.initialConstraint;
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  // reason is required on BacktrackConstraint
  if (obj.reason === undefined || typeof obj.reason !== "object" || obj.reason === null) {
    return undefined;
  }

  return raw as unknown as BacktrackConstraint;
}

/**
 * Descriptor for guided-retry middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-guided-retry",
  aliases: ["guided-retry"],
  optionsValidator: (input) => validateRequiredDescriptorOptions(input, "Guided retry"),
  factory(options: JsonObject): KoiMiddleware {
    const constraint = parseInitialConstraint(options);
    const config: GuidedRetryConfig =
      constraint !== undefined ? { initialConstraint: constraint } : {};
    const handle = createGuidedRetryMiddleware(config);
    return handle.middleware;
  },
};
