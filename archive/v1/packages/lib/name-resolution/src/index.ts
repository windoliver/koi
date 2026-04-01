/**
 * @koi/name-resolution — Pure ANS algorithms (Layer 0u)
 *
 * Shared utilities for name resolution: composite keys, name validation,
 * scope-based resolution, and fuzzy matching. Used by both in-memory
 * and Nexus-backed name service backends.
 */

export { compositeKey, parseCompositeKey } from "./composite-key.js";
export { computeSuggestions } from "./fuzzy-matcher.js";
export type { ParsedModelId } from "./model-id.js";
export { extractProvider, parseModelId } from "./model-id.js";
export { validateName } from "./name-validation.js";
export { resolveByScope } from "./scope-resolver.js";
