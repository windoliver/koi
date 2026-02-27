/**
 * Shared constants for the forge package.
 *
 * Single source of truth — avoids DEFAULT_SANDBOX_TIMEOUT_MS being defined
 * in 3+ files with risk of silent divergence.
 */

/** Default sandbox execution timeout in milliseconds. */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

/** Safety cap — catches leaked listeners before they accumulate unboundedly. */
export const MAX_EXTERNAL_LISTENERS = 64;

/** Default LRU cache capacity for attestation verification results. */
export const DEFAULT_ATTESTATION_CACHE_CAP = 512;
