/**
 * BrickDescriptor for @koi/middleware-guided-retry.
 *
 * Enables manifest auto-resolution: validates initial constraint options,
 * then creates the guided retry middleware.
 */

import type { KoiMiddleware } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createGuidedRetryMiddleware } from "./guided-retry.js";

/**
 * Descriptor for guided-retry middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-guided-retry",
  aliases: ["guided-retry"],
  optionsValidator: (input) => validateRequiredDescriptorOptions(input, "Guided retry"),
  factory(): KoiMiddleware {
    const handle = createGuidedRetryMiddleware({});
    return handle.middleware;
  },
};
