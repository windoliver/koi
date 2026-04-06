/**
 * Module-private trusted-pattern registry.
 *
 * Factory-created patterns are recorded in a module-private `WeakSet` so the
 * ReDoS timing check in config.ts can skip them — they are curated built-ins.
 *
 * Why a WeakSet rather than a symbol attached to the object:
 *   A symbol stamped on an exported pattern is discoverable via
 *   `Object.getOwnPropertySymbols(builtin)` and can be re-applied to a
 *   caller-controlled object to bypass the trust check. Keeping the trust
 *   state in a module-private registry means the trust decision cannot be
 *   influenced from outside this module by reflection on pattern objects.
 */

import type { SecretPattern } from "./types.js";

/** Module-private — never exported. Entries are GC'd with their pattern object. */
const trustedRegistry = new WeakSet<SecretPattern>();

/** Check whether a pattern was produced by the built-in factory. */
export function isTrustedPattern(p: SecretPattern): boolean {
  return trustedRegistry.has(p);
}

/**
 * Register a pattern as trusted and freeze it so its `detect` function cannot
 * be replaced by a caller who obtains the object reference.
 *
 * Freezing also prevents a caller from mutating a shared built-in detector
 * (reachable via `DEFAULT_REDACTION_CONFIG.patterns`) to poison redaction
 * process-wide.
 */
export function markTrusted<T extends SecretPattern>(p: T): Readonly<T> {
  const frozen = Object.freeze(p);
  trustedRegistry.add(frozen);
  return frozen;
}
