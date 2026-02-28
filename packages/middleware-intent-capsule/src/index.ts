/**
 * @koi/middleware-intent-capsule — Cryptographic mandate binding for ASI01 defense (Layer 2)
 *
 * Signs the agent's mandate (system prompt + objectives) with Ed25519 at session
 * start, then verifies mandate integrity on every model call. Defends against
 * OWASP ASI01 (Agentic Goal Hijacking) by making the original mandate
 * tamper-evident and unforgeable.
 *
 * Middleware name: "intent-capsule"
 * Priority: 290
 *
 * Add to manifest:
 *   middleware:
 *     - name: intent-capsule
 *
 * Depends on @koi/core and @koi/crypto-utils only.
 */

export type { MandateFields } from "./canonicalize.js";
export { canonicalizeMandatePayload } from "./canonicalize.js";
export type { IntentCapsuleConfig } from "./config.js";
export { DEFAULT_CAPSULE_TTL_MS, resolveConfig } from "./config.js";
export { createIntentCapsuleMiddleware } from "./middleware.js";
