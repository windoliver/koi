/**
 * Module-private trusted-pattern branding.
 *
 * Factory-created patterns are stamped with a non-enumerable Symbol so the
 * ReDoS timing check in config.ts can skip them — they are curated built-ins.
 */

import type { SecretPattern } from "./types.js";

/** Invisible brand key — not exported from the package public API. */
const TRUSTED_PATTERN: unique symbol = Symbol("koi.redaction.trusted");

/** Check whether a pattern was produced by the built-in factory. */
export function isTrustedPattern(p: SecretPattern): boolean {
  return TRUSTED_PATTERN in p;
}

/**
 * Stamp a pattern as trusted and freeze it so its `detect` function cannot
 * be replaced by a caller who obtains the object reference.
 *
 * Freezing prevents the mutable-identity bypass: a caller could otherwise
 * get a branded built-in, overwrite its `detect` with a slow implementation,
 * and re-submit it; the trust check would still pass and the ReDoS probe
 * would be skipped. Freezing closes that door.
 */
export function markTrusted<T extends SecretPattern>(p: T): Readonly<T> {
  Object.defineProperty(p, TRUSTED_PATTERN, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(p);
}
