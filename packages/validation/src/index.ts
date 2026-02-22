/**
 * @koi/validation — Shared Zod validation utilities (Layer 2)
 *
 * Provides zodToKoiError and validateWith for consistent config validation
 * across L2 packages. Depends on @koi/core (for KoiError/Result) and zod.
 */

export { validateWith, zodToKoiError } from "./validation.js";
