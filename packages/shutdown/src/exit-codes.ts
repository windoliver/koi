/**
 * Process exit codes — sysexits.h-inspired constants.
 *
 * Used by service managers to decide restart behavior.
 * - EXIT_CONFIG (78) → RestartPreventExitStatus in systemd (won't restart on config errors)
 * - EXIT_ERROR (1) → restart appropriate
 * - EXIT_UNAVAILABLE (69) → retry later
 */

/** Clean exit — no errors. */
export const EXIT_OK = 0;

/** Runtime error — restart may help. */
export const EXIT_ERROR = 1;

/** Dependency unavailable — retry later. */
export const EXIT_UNAVAILABLE = 69;

/** Configuration error — restart won't help. */
export const EXIT_CONFIG = 78;
