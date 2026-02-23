/**
 * @koi/validation — Shared validation utilities (Layer 2)
 *
 * Provides zodToKoiError and validateWith for consistent config validation,
 * plus validateBrickArtifact for storage backend deserialization.
 * Depends on @koi/core (for KoiError/Result) and zod.
 */

export { validateBrickArtifact } from "./brick-validation.js";
export { validateWith, zodToKoiError } from "./validation.js";
