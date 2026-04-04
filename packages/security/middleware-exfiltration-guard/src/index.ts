/**
 * @koi/middleware-exfiltration-guard — Secret exfiltration prevention middleware.
 *
 * Scans tool inputs and model outputs for base64-encoded, URL-encoded,
 * and raw secret patterns. Blocks, redacts, or warns on detection.
 */

export type {
  ExfiltrationAction,
  ExfiltrationEvent,
  ExfiltrationGuardConfig,
} from "./config.js";
export {
  DEFAULT_EXFILTRATION_GUARD_CONFIG,
  validateExfiltrationGuardConfig,
} from "./config.js";
export { createExfiltrationGuardMiddleware } from "./middleware.js";
