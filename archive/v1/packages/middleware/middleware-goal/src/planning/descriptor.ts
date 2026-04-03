/**
 * BrickDescriptor for @koi/middleware-goal (planning).
 *
 * Enables manifest auto-resolution: validates planning config options,
 * then creates the plan middleware.
 */

import type { KoiMiddleware } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createPlanMiddleware } from "./plan-middleware.js";

/**
 * Descriptor for planning middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-goal",
  aliases: ["planning"],
  optionsValidator: (input) => validateRequiredDescriptorOptions(input, "Planning"),
  factory(): KoiMiddleware {
    return createPlanMiddleware();
  },
};
