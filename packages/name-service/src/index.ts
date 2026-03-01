/**
 * @koi/name-service — DNS-like name resolution for agents and bricks (Layer 2)
 *
 * Provides name registration, scoped resolution, alias support, TTL-based
 * expiry, and fuzzy "did you mean?" suggestions.
 * Depends on @koi/core (L0) and @koi/validation (L0u).
 */

export { createNameServiceProvider } from "./component-provider.js";
export { createInMemoryNameService } from "./in-memory-backend.js";
export { validateName } from "./name-validation.js";
export { createRegistrySync } from "./registry-sync.js";
