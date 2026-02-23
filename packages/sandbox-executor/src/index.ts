/**
 * @koi/sandbox-executor — Trust-tiered sandbox executor dispatcher (L2).
 *
 * Routes execute() calls to per-tier backends based on brick trust tier.
 * Promoted tier has a built-in `new Function()` executor by default.
 */

export { createPromotedExecutor } from "./promoted-executor.js";
export type { TieredExecutorConfig } from "./resolve.js";
export { createTieredExecutor } from "./tiered-executor.js";
